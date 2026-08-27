/**
 * 活跃执行控制器：保存正在进行的会话执行权及其可中断控制器。
 *
 * 放在 `core/execution/` 是因为 ask / stop / regenerate 三条路由都要读写它，
 * 是横切关注点。
 *
 * 关键约束：
 * - 该控制器刻意独立于 DB 持久化层——重启后必然清空，DB 才是事实来源。
 * - abortExecution 不立即清理记录，必须等流任务的 finally 调用
 *   cleanupExecution——避免"已停止"和"流收敛"出现竞态。
 * - 互斥仅在单 Node.js 进程内有效。多实例部署需要 DB 租约 / 分布式锁 /
 *   messages.conversation_id + status 唯一约束——本模块不提供跨进程互斥。
 * - 两张索引（conversationId 与 assistantMessageId）必须由统一方法维护，
 *   不得散落写入，否则会出现"已停止但还显示活跃"或"已释放但 stop 仍命中"
 *   等不一致状态。
 */

interface ActiveExecution {
  conversationId: string;
  /** 预留阶段为 null；创建助手消息并绑定后才填入。 */
  assistantMessageId: string | null;
  controller: AbortController;
  partialContent: string;
}

const activeByConversation = new Map<string, ActiveExecution>();
const activeByMessage = new Map<string, string>();

export class ExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConflictError';
  }
}

/**
 * 原子预占会话执行权。
 *
 * check-then-set 会产生竞态：两个并发 `/ask` 都可能看到 `!has` 然后都 set。
 * 这里用"一次 Map 写入"保证同一会话不会被并发预占两次。
 */
export function tryReserveConversationExecution(
  conversationId: string,
): { controller: AbortController } | { conflict: ExecutionConflictError } {
  if (activeByConversation.has(conversationId)) {
    return { conflict: new ExecutionConflictError('该会话正在生成中，请等待完成或停止后再试。') };
  }
  const controller = new AbortController();
  const execution: ActiveExecution = {
    conversationId,
    assistantMessageId: null,
    controller,
    partialContent: '',
  };
  activeByConversation.set(conversationId, execution);
  return { controller };
}

/**
 * 将助手消息 ID 绑定到已预占的会话执行。
 *
 * 不变量（不依赖调用方时序正确）：
 *  - 调用方必须先 `tryReserveConversationExecution` 成功；本方法不二次预占。
 *  - 若 `conversationId` 还未预占 → 抛 `执行预占已丢失`。
 *  - 若 `conversationId` 已绑定到另一个 `assistantMessageId` → 抛错，**不**
 *    静默覆盖旧绑定（避免双索引失同步导致 stop / cleanupExecution 误命中）。
 *  - 若 `assistantMessageId` 已绑定到另一个 `conversationId` → 抛错，**不**
 *    跨会话挪动旧绑定。
 *  - 同一 `(conversationId, assistantMessageId)` 重复 bind 视为幂等成功。
 */
export function bindAssistantMessageToExecution(
  conversationId: string,
  assistantMessageId: string,
): void {
  const execution = activeByConversation.get(conversationId);
  if (!execution) {
    throw new Error('执行预占已丢失，无法绑定助手消息。');
  }

  const existingConversationForMessage = activeByMessage.get(assistantMessageId);
  if (existingConversationForMessage && existingConversationForMessage !== conversationId) {
    throw new Error(
      `助手消息 ${assistantMessageId} 已绑定到会话 ${existingConversationForMessage}，` +
      `无法再次绑定到会话 ${conversationId}。`,
    );
  }

  if (execution.assistantMessageId && execution.assistantMessageId !== assistantMessageId) {
    throw new Error(
      `会话 ${conversationId} 已绑定到助手消息 ${execution.assistantMessageId}，` +
      `无法再次绑定到 ${assistantMessageId}。`,
    );
  }

  // 幂等：同 (conversationId, assistantMessageId) 重复 bind 不变更状态。
  execution.assistantMessageId = assistantMessageId;
  activeByMessage.set(assistantMessageId, conversationId);
}

export function isConversationExecutionActive(conversationId: string): boolean {
  return activeByConversation.has(conversationId);
}

export function isExecutionActive(assistantMessageId: string): boolean {
  return activeByMessage.has(assistantMessageId);
}

export function abortExecution(
  assistantMessageId: string,
): { success: boolean; partialContent: string | null } {
  const conversationId = activeByMessage.get(assistantMessageId);
  if (!conversationId) {
    return { success: false, partialContent: null };
  }
  const execution = activeByConversation.get(conversationId);
  if (!execution) {
    return { success: false, partialContent: null };
  }
  const partialContent = execution.partialContent || null;
  execution.controller.abort();
  // 不立即删除，保持为"正在收敛"直到流任务的 finally 调用 cleanupExecution
  return { success: true, partialContent };
}

export function appendPartialContent(assistantMessageId: string, delta: string): void {
  const conversationId = activeByMessage.get(assistantMessageId);
  if (!conversationId) return;
  const execution = activeByConversation.get(conversationId);
  if (!execution) return;
  execution.partialContent += delta;
}

/**
 * 旧接口兼容：行为等价于 `appendPartialContent`。
 * 保留以免破坏 ask-driver 旧调用点。
 */
export function updatePartialContent(assistantMessageId: string, delta: string): void {
  appendPartialContent(assistantMessageId, delta);
}

export function getPartialContent(assistantMessageId: string): string {
  const conversationId = activeByMessage.get(assistantMessageId);
  if (!conversationId) return '';
  return activeByConversation.get(conversationId)?.partialContent ?? '';
}

/**
 * 按助手消息 ID 清理执行记录：双索引同步删除。
 */
export function cleanupExecution(assistantMessageId: string): void {
  const conversationId = activeByMessage.get(assistantMessageId);
  if (!conversationId) return;
  activeByMessage.delete(assistantMessageId);
  // 仅在会话执行当前仍指向该消息时才删除会话记录，避免误删另一并发请求的预占。
  const execution = activeByConversation.get(conversationId);
  if (execution && execution.assistantMessageId === assistantMessageId) {
    activeByConversation.delete(conversationId);
  }
}

/**
 * 按会话 ID 清理执行记录：用于 setup 阶段失败时的整体释放。
 * 即便消息索引中仍残留指向该会话的旧条目，也会一并清空。
 */
export function cleanupConversationExecution(conversationId: string): void {
  const execution = activeByConversation.get(conversationId);
  if (!execution) return;
  if (execution.assistantMessageId) {
    activeByMessage.delete(execution.assistantMessageId);
  }
  activeByConversation.delete(conversationId);
}

/**
 * 仅供测试：彻底清空所有状态，防止测试间相互污染。
 */
export function resetExecutionControllerForTests(): void {
  activeByConversation.clear();
  activeByMessage.clear();
}

/**
 * 旧接口兼容：保留 `tryRegisterExecution` 行为，绑定"会话 + 消息 ID"两步合一。
 * 仅用于 ask-driver 的旧路径；新代码应直接调用 `tryReserveConversationExecution`
 * + `bindAssistantMessageToExecution`。
 */
export function tryRegisterExecution(
  assistantMessageId: string,
): { controller: AbortController } | { conflict: ExecutionConflictError } {
  // 没有 conversationId 上下文时无法做会话级互斥——这里使用消息 ID 作为会话键的退化实现，
  // 调用方应优先使用 `tryReserveConversationExecution` 路径。
  if (activeByMessage.has(assistantMessageId)) {
    return { conflict: new ExecutionConflictError('该消息正在生成中，请等待完成或停止后再试。') };
  }
  const controller = new AbortController();
  const execution: ActiveExecution = {
    conversationId: assistantMessageId,
    assistantMessageId,
    controller,
    partialContent: '',
  };
  activeByConversation.set(assistantMessageId, execution);
  activeByMessage.set(assistantMessageId, assistantMessageId);
  return { controller };
}
