/**
 * 实时增量 JSON-payload 字节安全拆分（PR-2.4 修复 commit）。
 *
 * 背景：
 *   - PostgreSQL `pg_notify(channel, payload)` 单条 payload 上限是 8000 byte；
 *     保留安全余量（7900 byte）以避免 protocol-level 失败。
 *   - 实时增量走 LISTEN/NOTIFY 通道（`agent_run_live_deltas_channel`）。
 *     缺失允许——若一次 model delta 超长，应当按字节安全边界拆成多包。
 *   - payload 形如 `{"runId":"<uuid>","text":"<escaped text>"}`；
 *     拆分**必须按最终 JSON payload 的字节**判断边界，而不是按原始 text 字节。
 *     因为 JSON 转义会让 `"`、`\`、某些控制字符在最终 payload 中比原始
 *     字符占更多字节。
 *   - 不能简单按字符数拆：中文 / emoji / surrogate pair / 多字节字符
 *     不能被截断，否则 SSE 帧会输出损坏字符。
 *
 * 拆分策略：
 *   - 维护 buf + `bufJsonBytes`（`Buffer.byteLength(JSON.stringify(buf))`，
 *     即 buf 经 JSON 编码后的 UTF-8 字节数，**含外层 quotes**）。
 *   - 每次迭代取下一个 codePoint：
 *       * `cpJsonBytes` = 该字符在 JSON 编码后占的字节增量（见 `jsonByteCost`）；
 *       * 若单字符 `cpJsonBytes > maxTextBytes - 2`（即便只剩外层 quotes 也装不下）
 *         → 丢弃，记录 `droppedBytes`；
 *       * 若 `bufJsonBytes + cpJsonBytes >= maxTextBytes` → flush 当前 buf，开新 buf；
 *       * 否则 → 追加。
 *   - 贪心装填；多字节字符（含 4-byte emoji）永远作为整体保留，
 *     绝不拆 surrogate pair。
 *
 * 本模块是纯函数；测试见 `tests/unit/live-delta-splitter.test.ts`。
 */

export interface SplitResult {
  chunks: string[];
  /**
   * 每个 chunk 经 JSON 编码后的 UTF-8 字节数（含外层 quotes），与 `chunks` 一一对应。
   * 调用方可用此与 envelope 模板拼成完整 payload：
   *   final payload bytes = envelopePrefixBytes + chunkJsonBytes[i] + envelopeSuffixBytes
   */
  chunkJsonBytes: number[];
  /** 实际 drop 的 JSON 字节数（仅"单字符本身就超过 maxBytes"等极少数情况；正常为 0）。 */
  droppedBytes: number;
}

export interface SplitByJsonTextBytesOptions {
  /** 待拆分原始文本。 */
  text: string;
  /** envelope 在 text 之前的固定字节数（即 `{"runId":"<uuid>","text":`，不含 text 起始的 `"`）。 */
  envelopePrefixBytes: number;
  /** envelope 在 text 之后的固定字节数（即 `"}`，不含 text 末尾的 `"`）。 */
  envelopeSuffixBytes: number;
  /**
   * 整个最终 JSON payload 的**严格**上限：每个 chunk 拼 envelope 后必须 < maxPayloadBytes。
   */
  maxPayloadBytes: number;
}

/**
 * 把 text 按"最终 JSON payload 字节数"拆成多个 chunk；拼回 envelope 后每个
 * 最终 payload 都严格 < maxPayloadBytes。
 */
export function splitByJsonTextBytes(opts: SplitByJsonTextBytesOptions): SplitResult {
  const { text, envelopePrefixBytes, envelopeSuffixBytes, maxPayloadBytes } = opts;
  if (maxPayloadBytes <= 0) {
    throw new Error(`splitByJsonTextBytes: maxPayloadBytes 必须 > 0，实际=${maxPayloadBytes}`);
  }
  if (envelopePrefixBytes < 0 || envelopeSuffixBytes < 0) {
    throw new Error(
      `splitByJsonTextBytes: envelope prefix/suffix bytes 必须 >= 0，实际=${envelopePrefixBytes}/${envelopeSuffixBytes}`,
    );
  }
  if (maxPayloadBytes <= envelopePrefixBytes + envelopeSuffixBytes) {
    throw new Error(
      `splitByJsonTextBytes: maxPayloadBytes (${maxPayloadBytes}) 必须 > envelope 总开销 (${envelopePrefixBytes + envelopeSuffixBytes})`,
    );
  }
  if (!text) return { chunks: [], chunkJsonBytes: [], droppedBytes: 0 };

  // maxTextBytes 是 bufJsonBytes（含外层 quotes）的上限。
  // final payload = prefix + bufJsonBytes + suffix，要求 < maxPayloadBytes，
  // 即 bufJsonBytes < maxTextBytes。
  const maxTextBytes = maxPayloadBytes - envelopePrefixBytes - envelopeSuffixBytes;
  const chunks: string[] = [];
  const chunkJsonBytes: number[] = [];
  let droppedBytes = 0;
  let buf = '';
  // 空 buf 的 JSON 字节就是 2 个外层 quotes。后续每个字符追加时，
  // bufJsonBytes 始终 === Buffer.byteLength(JSON.stringify(buf))。
  let bufJsonBytes = 2;

  for (const codePoint of text) {
    const cpJsonBytes = jsonByteCost(codePoint);

    if (cpJsonBytes > maxTextBytes - 2) {
      // 即便只算单字符自身就超过 maxTextBytes（去掉外层 quotes 的预算）；
      // 含 quotes 一定超阈值。丢弃，避免产生 broken payload。
      droppedBytes += cpJsonBytes + 2; // 算上外层 quotes 的真实字节开销
      continue;
    }
    if (bufJsonBytes + cpJsonBytes >= maxTextBytes) {
      // 装不下当前 cp，flush 当前 buf。
      if (buf.length > 0) {
        chunks.push(buf);
        chunkJsonBytes.push(bufJsonBytes);
      }
      buf = codePoint;
      bufJsonBytes = 2 + cpJsonBytes; // 新 buf：外层 quotes + 当前字符
    } else {
      buf += codePoint;
      bufJsonBytes += cpJsonBytes;
    }
  }
  if (buf.length > 0) {
    chunks.push(buf);
    chunkJsonBytes.push(bufJsonBytes);
  }

  // 二次校验：用 envelope 模板拼回每个 chunk，确认最终 payload 字节 < 上限。
  // 正常输入下不应触发；只作为算法正确性的内嵌断言。
  for (let i = 0; i < chunks.length; i++) {
    const totalBytes = envelopePrefixBytes + chunkJsonBytes[i]! + envelopeSuffixBytes;
    if (totalBytes >= maxPayloadBytes) {
      throw new Error(
        `splitByJsonTextBytes: 内部错误：chunk#${i} 最终 payload=${totalBytes}B >= maxPayloadBytes=${maxPayloadBytes}`,
      );
    }
  }
  return { chunks, chunkJsonBytes, droppedBytes };
}

/**
 * 单个 codePoint 加入到已有 JSON 字符串字面量时增加的字节数。
 *
 * JSON 编码规则（ECMA-404 / RFC 8259）：
 *   - `"` → `\"`（2 字节）；
 *   - `\` → `\\`（2 字节）；
 *   - 五个特殊控制字符的短转义（2 字节）：
 *       `\b` (U+0008), `\t` (U+0009), `\n` (U+000A), `\f` (U+000C), `\r` (U+000D)；
 *   - 其它控制字符（U+0000..U+001F 中剩余的）→ `\uXXXX`（6 字节）；
 *   - 其它字符 → 与其 UTF-8 编码字节数一致（1 / 2 / 3 / 4）。
 *
 * 注：不包含外层 quotes。
 */
export function jsonByteCost(codePoint: string): number {
  const code = codePoint.codePointAt(0)!;
  if (code === 0x22 /* " */ || code === 0x5C /* \ */) return 2;
  if (
    code === 0x08 /* \b */ ||
    code === 0x09 /* \t */ ||
    code === 0x0A /* \n */ ||
    code === 0x0C /* \f */ ||
    code === 0x0D /* \r */
  ) {
    return 2;
  }
  if (code < 0x20 /* 其它控制字符 */) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * 计算 envelope 的 prefix/suffix 字节数（不含 text 自身及其外层 quotes）。
 *
 * 调用方构造 payload 时使用：
 *   const payload = `${envelope},"text":${JSON.stringify(chunk)}}`;
 * 即 prefix = `${envelope},"text":`，suffix = `}`。
 */
export function jsonEnvelopeSplitBytes(payload: { runId: string }): {
  prefixBytes: number;
  suffixBytes: number;
} {
  const envelope = JSON.stringify(payload);
  const prefix = `${envelope},"text":`;
  const suffix = `}`;
  return {
    prefixBytes: Buffer.byteLength(prefix, 'utf8'),
    suffixBytes: Buffer.byteLength(suffix, 'utf8'),
  };
}

/**
 * 计算 `JSON.stringify(payload)` 在 UTF-8 下的字节长度。
 */
export function jsonByteLength(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}