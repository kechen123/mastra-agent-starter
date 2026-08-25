const activeExecutions = new Map<string, AbortController>();
const partialContents = new Map<string, string>();

export function registerExecution(assistantMessageId: string): AbortController {
  if (activeExecutions.has(assistantMessageId)) {
    throw new ExecutionConflictError('该消息正在生成中，请等待完成或停止后再试。');
  }
  const controller = new AbortController();
  activeExecutions.set(assistantMessageId, controller);
  partialContents.set(assistantMessageId, '');
  return controller;
}

export function updatePartialContent(assistantMessageId: string, delta: string): void {
  const current = partialContents.get(assistantMessageId) ?? '';
  partialContents.set(assistantMessageId, current + delta);
}

export function abortExecution(assistantMessageId: string): { success: boolean; partialContent: string | null } {
  const controller = activeExecutions.get(assistantMessageId);
  const partialContent = partialContents.get(assistantMessageId) ?? null;
  if (!controller) {
    return { success: false, partialContent };
  }
  controller.abort();
  // 不立即删除，保持为"正在收敛"直到流任务的 finally 调用 cleanupExecution
  return { success: true, partialContent };
}

export function isExecutionActive(assistantMessageId: string): boolean {
  return activeExecutions.has(assistantMessageId);
}

export function cleanupExecution(assistantMessageId: string): void {
  activeExecutions.delete(assistantMessageId);
  partialContents.delete(assistantMessageId);
}

export class ExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConflictError';
  }
}
