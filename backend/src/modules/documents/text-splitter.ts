/**
 * PR-4.2：文档文本切分（共享给 ingestion worker 与同步上传路由）。
 *
 * 设计：
 *   - 与历史 `routes/documents.ts:splitText` 行为保持一致，避免
 *     PR-4.2 落地后切分边界变化导致 RAG 检索语义漂移；
 *   - CHUNK_SIZE / CHUNK_OVERLAP 是**默认值**，调用方可覆盖；
 *   - 返回的 chunks 包含 `heading`（从最近的 markdown heading 提取）
 *     用于 RAG citation 元数据。
 *
 * 关于"切分单位"：
 *   - 当前 Starter 文档均为文本型（TXT / MD / PDF 经 MinerU 解析后为
 *     markdown / DOCX 经转换后为 markdown）；
 *   - 表格 / 图片未单独切分；后续 PR 可在此扩展。
 */

export interface TextChunk {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  heading?: string;
}

export interface TextSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1_000;
const DEFAULT_CHUNK_OVERLAP = 150;

export function splitText(text: string, options: TextSplitterOptions = {}): TextChunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  if (chunkSize <= 0) throw new Error('chunkSize 必须为正整数。');
  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error('chunkOverlap 必须满足 0 ≤ chunkOverlap < chunkSize。');
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const targetEnd = Math.min(start + chunkSize, text.length);
    const end = targetEnd === text.length ? targetEnd : findBoundary(text, start, targetEnd, chunkSize);
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        chunkIndex: chunks.length,
        startChar: start,
        endChar: end,
        heading: findHeading(text, start),
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - chunkOverlap, start + 1);
  }
  return chunks;
}

function findBoundary(text: string, start: number, targetEnd: number, chunkSize: number): number {
  const minimumBoundary = start + Math.floor(chunkSize * 0.5);
  const candidates = ['\n\n', '\n', '。', '！', '？', '；'];
  let best = -1;
  let boundaryLength = 0;
  for (const delimiter of candidates) {
    const index = text.lastIndexOf(delimiter, targetEnd - 1);
    if (index >= minimumBoundary && index > best) {
      best = index;
      boundaryLength = delimiter.length;
    }
  }
  return best >= 0 ? best + boundaryLength : targetEnd;
}

function findHeading(text: string, position: number): string | undefined {
  const headingAtChunkStart = text.slice(position).match(/^#{1,6}\s+([^\n]+)/)?.[1]?.trim();
  if (headingAtChunkStart) return headingAtChunkStart;
  const preceding = text.slice(0, position);
  const matches = [...preceding.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const heading = matches.at(-1)?.[1]?.trim();
  return heading || undefined;
}
