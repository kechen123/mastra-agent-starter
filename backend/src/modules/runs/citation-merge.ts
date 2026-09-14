/**
 * Citation 合并：按稳定字段 chunkId 去重，incoming 优先。
 *
 * 提取为独立模块的动机（PR-review Round 3 Item 3 修复）：
 *   - `modules/runs/service.ts`（stopRunByMessageId 路径）
 *   - `core/execution/run-executor.ts`（V2 stopRun 路径）
 *   此前都复制了一份"按 chunkId 取并集"的 JS 逻辑，且
 *   `tests/unit/round2-citations-tool-backfill.ts` 也复制了一份。
 *   测试断言复制代码等于没测——只能验证自己的副本。
 *
 *   现在统一用此模块导出 `mergeCitationsByChunkId`，三个调用点共用，
 *   测试也直接 import 它断言生产实现。
 */

export interface CitationLike {
  /** 稳定去重键。生产类型 `Citation.chunkId` 是必填 string；本接口
   *  容忍来源未规范化的对象（来自 raw DB JSON / 测试 fixture），所以
   *  标注 optional + unknown，由实现函数内做 typeof 守卫。 */
  chunkId?: unknown;
}

/**
 * 按 chunkId 取并集，incoming 优先；同 chunkId 视作同一引用（incoming
 * 覆盖 existing 的整条字段，便于更新 score / title 等元数据）。
 *
 * 行为：
 *   - incoming 为 null/undefined/空数组 → 不写；返回 existing 副本；
 *   - incoming 非空：merged 数组 = incoming（顺序保留） + existing 中
 *     chunkId 不在 incoming 集合的部分；
 *   - incoming / existing 中无 chunkId 字段的引用：仍保留位置但无法
 *     去重 → 推入。
 *
 *  返回值 `{ write, merged }`：调用方根据 write 决定是否 UPDATE citations 列。
 */
export function mergeCitationsByChunkId(
  existing: ReadonlyArray<CitationLike>,
  incoming: ReadonlyArray<CitationLike> | null | undefined,
): { write: boolean; merged: CitationLike[] } {
  if (!incoming || incoming.length === 0) {
    return { write: false, merged: [...existing] };
  }
  const merged: CitationLike[] = [];
  const seenChunkIds = new Set<string>();
  for (const inc of incoming) {
    const chunkId = typeof inc.chunkId === 'string' ? inc.chunkId : null;
    if (chunkId) {
      merged.push({ ...inc });
      seenChunkIds.add(chunkId);
    } else {
      merged.push({ ...inc });
    }
  }
  for (const ex of existing) {
    const chunkId = typeof ex.chunkId === 'string' ? ex.chunkId : null;
    if (!chunkId || !seenChunkIds.has(chunkId)) merged.push({ ...ex });
  }
  return { write: true, merged };
}

/**
 * 给 run-stopped / run-completed SSE 事件构造 payload。
 *
 * 单一来源（PR-review Round 3 Item 1 + Round 5 Item 1）：HTTP 响应体
 * 与 SSE payload 都基于此函数，避免两处实现漂移；citations 必须是
 * 已合并并持久化的最终数组（service.ts / run-executor.ts 的
 * `finalCitationsForPayload`），不再用 incoming。
 *
 * 参数类型故意放宽到 `ReadonlyArray<unknown>`：调用点拿到的最终数组
 * 类型会随上下文变化（合并结果是 `Record<string, unknown>[]`，
 * 反查结果是 `unknown[]`），把每个调用点的 cast 集中到这一处即可。
 */
export function buildRunTerminalPayload(
  content: string,
  citations: ReadonlyArray<unknown>,
): { contentLength: number; citations: ReadonlyArray<unknown> } {
  return {
    contentLength: content.length,
    citations: citations ?? [],
  };
}

/**
 * tool_executions backfill 终态选择（PR-review Round 2 Item 3）：
 *   - 保留 input.status（success / error / cancelled），不再硬编码 cancelled；
 *   - error 字段额外拼 ';finalized_without_start' 标记，区分正常收敛
 *     与缺失 start 行的特殊场景。
 */
export function pickBackfillStatus(
  inputStatus: 'success' | 'error' | 'cancelled',
): 'success' | 'error' | 'cancelled' {
  return inputStatus;
}

export function buildBackfillError(originalError: string | undefined): string {
  return originalError ? `${originalError};finalized_without_start` : 'finalized_without_start';
}