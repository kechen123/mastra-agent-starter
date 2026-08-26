/**
 * 活跃执行控制器：保存正在进行的助手消息及其可中断控制器。
 *
 * 放在 `core/execution/` 是因为 ask / stop / regenerate 三条路由都要读写它，
 * 是横切关注点。
 *
 * 关键约束：
 * - 该控制器刻意独立于 DB 持久化层——重启后必然清空，DB 才是事实来源。
 * - abortExecution 不立即清理记录，必须等流任务的 finally 调用
 *   cleanupExecution——避免"已停止"和"流收敛"出现竞态。
 */

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