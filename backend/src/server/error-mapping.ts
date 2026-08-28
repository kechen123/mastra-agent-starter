/**
 * 统一的 error → HTTP 响应映射（PR-1.2/1.3/1.5）。
 *
 * 这是路由层**唯一**的 error 边界。`withAuthenticatedWorkspace` 包装器
 * （modules/auth/workspace-context.ts）和其他受保护路由 handler 都应调用
 * `mapErrorToResponse(error)`，再把结果喂给 `context.json(...)`，避免每个
 * 路由手写 try/catch + 401/404/422/500 分支。
 *
 * 映射约定：
 *   - `ResourceNotFoundError`     → 404 { error_code: 'NOT_FOUND',     message: '资源不存在。' }
 *   - `CrossWorkspaceAccessError` → 404 同上（继承 ResourceNotFoundError；**绝不**用 403 区分越权，
 *                                    防止泄漏 ID 存在性 / 越权状态 — V2.3.6 §5.1）
 *   - `InputValidationError`      → 422 { error_code: 'INPUT_VALIDATION_FAILED', message: <原 message> }
 *   - `UserNotFoundError`         → 500 { error_code: 'INTERNAL_ERROR', message: '服务端内部错误。' }
 *     （不要映射成 401 — 这是服务端完整性错误：用户存在但 session/DB 状态不一致）
 *   - `WorkspaceContextError`     → 500 同上
 *   - `WorkspaceIntegrityError`   → 500 同上
 *   - 任意其他 Error / 未知值    → 500 同上（兜底分支打 console.error，便于运维定位）
 *
 * `UserNotFoundError` / `WorkspaceContextError` / `WorkspaceIntegrityError`
 * 这三个类在 `modules/auth/workspace-context.ts` 中定义；本文件**不**重新
 * 声明，也**不**做跨模块 import，改为按 `error.name` 字符串判定，避免循环
 * 依赖 + 让本文件保持纯函数（无 DB 副作用）。
 */

export type ErrorMappingResult = {
  status: number;
  body: { error_code: string; message: string };
};

/**
 * 通用"资源不存在"。子类型 `CrossWorkspaceAccessError` 表示"跨 Workspace
 * 访问被拒"——故意**对外**映射为相同的 404 body，避免泄漏 ID 存在性 / 越权
 * 状态（攻击者无法通过 403/404 差异判断资源是否存在或属于其他 Workspace）。
 */
export class ResourceNotFoundError extends Error {
  constructor(message = '资源不存在。') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

/**
 * 跨 Workspace 访问被拒。继承 `ResourceNotFoundError` — 共享 404 body 通道，
 * 不暴露 403。`error.name` 仍为 `CrossWorkspaceAccessError`，便于日志层
 * 区分。
 */
export class CrossWorkspaceAccessError extends ResourceNotFoundError {
  constructor() {
    super('资源不存在。');
    this.name = 'CrossWorkspaceAccessError';
  }
}

/**
 * 客户端输入校验失败（Zod / 业务 schema）。映射 422，并把原始 message
 * 透传给前端。
 */
export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
  }
}

const NOT_FOUND_BODY = { error_code: 'NOT_FOUND', message: '资源不存在。' } as const;
const INTERNAL_BODY = {
  error_code: 'INTERNAL_ERROR',
  message: '服务端内部错误。',
} as const;

/**
 * 这些 error.name 在 `modules/auth/workspace-context.ts` 中定义；本文件不
 * import 它们的类（避免循环依赖 + 让 mapper 保持纯函数），而是用字符串
 * 比对 name 字段。
 */
const NAME_500 = new Set<string>([
  'UserNotFoundError',
  'WorkspaceContextError',
  'WorkspaceIntegrityError',
]);

/**
 * 这些 error.name 与路由层抛出的错误一一对应；本地定义的 ResourceNotFoundError
 * / InputValidationError 也用 name 匹配，让单测可以用 vanilla Error + setName
 * 直接伪造（避免单测 import 具体类 + 防循环依赖）。
 */
const NAME_404 = new Set<string>([
  'ResourceNotFoundError',
  'CrossWorkspaceAccessError',
]);
const NAME_422 = new Set<string>(['InputValidationError']);

export function mapErrorToResponse(error: unknown): ErrorMappingResult {
  if (error instanceof Error && NAME_404.has(error.name)) {
    // CrossWorkspaceAccessError 继承自 ResourceNotFoundError，会一并命中此 case。
    return { status: 404, body: { ...NOT_FOUND_BODY } };
  }
  if (error instanceof Error && NAME_422.has(error.name)) {
    return {
      status: 422,
      body: { error_code: 'INPUT_VALIDATION_FAILED', message: error.message },
    };
  }
  if (error instanceof Error && NAME_500.has(error.name)) {
    console.error('服务端完整性错误：', error);
    return { status: 500, body: { ...INTERNAL_BODY } };
  }
  console.error('未预期错误：', error);
  return { status: 500, body: { ...INTERNAL_BODY } };
}