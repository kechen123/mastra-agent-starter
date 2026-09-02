/**
 * 把 Provider / Mastra 文本帧收敛为内部唯一允许的"纯增量"契约。
 *
 * 某些 Provider 的 `text-delta` 事件携带的是累计快照（`1`、`12`、`123`），
 * 另一些则携带纯增量（`1`、`2`、`3`）。HTTP SSE、Run executor 和持久化层
 * 都只应看到纯增量，避免每一层各自猜测并重复文本。
 */
export function normalizeTextChunk(
  accumulatedText: string,
  incomingText: string,
): { delta: string; accumulatedText: string } {
  if (!incomingText) return { delta: '', accumulatedText };

  // 累计快照：只转发相对已有前缀的新增后缀。这里必须是**严格更长**，
  // 否则纯增量流连续产生相同 token（例如 "哈"、"哈"）会被错误吞掉。
  if (incomingText.length > accumulatedText.length && incomingText.startsWith(accumulatedText)) {
    return {
      delta: incomingText.slice(accumulatedText.length),
      accumulatedText: incomingText,
    };
  }

  // 不是已有文本的扩展则按 Provider 的纯增量契约处理。不能根据
  // `endsWith` 等启发式去重：例如模型确实可能连续生成相同 token。
  return {
    delta: incomingText,
    accumulatedText: accumulatedText + incomingText,
  };
}
