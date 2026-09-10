/**
 * V2 重新生成路由契约测试（静态）。
 *
 * 覆盖 PR-UI-1.0.5 验收 §8：
 *   - 路由注册在 v2alpha + v1 同行为入口；
 *   - handler 由 withAuthenticatedWorkspace 包裹；
 *   - 响应字段 assistantMessageId / replacedAssistantMessageId / runId / eventsUrl
 *     全部存在；
 *   - service.createRegenerateRun 签名稳定（参数 + 返回值字段）。
 *
 * 这是纯文本扫描 + 类型提取，不依赖 DB。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const V2ALPHA = join(process.cwd(), 'src', 'server', 'routes', 'v2alpha', 'index.ts');
const SHARED = join(process.cwd(), 'src', 'server', 'routes', 'v2alpha', 'shared-handlers.ts');
const SERVICE = join(process.cwd(), 'src', 'modules', 'runs', 'service.ts');

const v2alphaSrc = readFileSync(V2ALPHA, 'utf-8');
const sharedSrc = readFileSync(SHARED, 'utf-8');
const serviceSrc = readFileSync(SERVICE, 'utf-8');

// 1. v2alpha 路径注册。
assert.match(
  v2alphaSrc,
  /registerApiRoute\(\s*'\/v1\/v2alpha\/messages\/:id\/regenerate'\s*,\s*\{[^}]*method:\s*'POST'/s,
  'v2alpha /messages/:id/regenerate 必须以 POST 注册',
);
assert.match(
  v2alphaSrc,
  /registerApiRoute\(\s*'\/v1\/messages\/:id\/regenerate'\s*,\s*\{[^}]*method:\s*'POST'/s,
  'v1 /messages/:id/regenerate 必须以 POST 注册（同行为入口）',
);

// 2. handler 由 runWith(...) 调用，内部使用 withAuthenticatedWorkspace。
assert.match(
  v2alphaSrc,
  /regenerateMessageV2AlphaRoute[\s\S]*?runWith\(sharedHandlers\.regenerateMessage,\s*'v2alpha'\)/,
  'v2alpha regenerate 必须调用 sharedHandlers.regenerateMessage',
);
assert.match(
  v2alphaSrc,
  /regenerateMessageV1Route[\s\S]*?runWith\(sharedHandlers\.regenerateMessage,\s*'v1'\)/,
  'v1 regenerate 必须调用 sharedHandlers.regenerateMessage',
);
assert.match(
  v2alphaSrc,
  /function runWith\([\s\S]*?withAuthenticatedWorkspace/,
  'runWith 内部必须用 withAuthenticatedWorkspace 包裹',
);

// 3. sharedHandlers.regenerateMessage 响应字段。
assert.match(
  sharedSrc,
  /async regenerateMessage[\s\S]*?assistantMessageId:\s*result\.assistantMessage\.id/,
  'regenerateMessage 必须返回 assistantMessageId',
);
assert.match(
  sharedSrc,
  /async regenerateMessage[\s\S]*?replacedAssistantMessageId:\s*result\.oldAssistantMessage\.id/,
  'regenerateMessage 必须返回 replacedAssistantMessageId',
);
assert.match(
  sharedSrc,
  /async regenerateMessage[\s\S]*?eventsUrl:\s*buildEventsUrl\(result\.run\.id,\s*deps\.base\)/,
  'regenerateMessage 必须返回 eventsUrl',
);
assert.match(
  sharedSrc,
  /async regenerateMessage[\s\S]*?responseStatus:\s*202/,
  'regenerateMessage 响应状态必须为 202',
);
// 错误码：跨 workspace 404 + 活跃 Run 409。
assert.match(
  sharedSrc,
  /regenerateMessage[\s\S]*?'NotFoundError'[\s\S]*?error_code:\s*'NOT_FOUND'[\s\S]*?404/,
  'regenerateMessage 必须在 NotFoundError 时返回 404 NOT_FOUND',
);
assert.match(
  sharedSrc,
  /regenerateMessage[\s\S]*?'ConversationActiveRunError'[\s\S]*?error_code:\s*'CONVERSATION_CONFLICT_ACTIVE_RUN'[\s\S]*?409/,
  'regenerateMessage 必须在 ConversationActiveRunError 时返回 409 CONVERSATION_CONFLICT_ACTIVE_RUN',
);

// 4. service.createRegenerateRun 必须存在并返回正确字段。
assert.match(
  serviceSrc,
  /export async function createRegenerateRun\(/,
  'createRegenerateRun 必须导出',
);
assert.match(
  serviceSrc,
  /createRegenerateRun[\s\S]*?assistantMessage:\s*\{\s*id:\s*newAssistantMessageId\s*\}/,
  'createRegenerateRun 必须返回 assistantMessage.id',
);
assert.match(
  serviceSrc,
  /createRegenerateRun[\s\S]*?oldAssistantMessage:\s*\{\s*id:\s*target\.id\s*\}/,
  'createRegenerateRun 必须返回 oldAssistantMessage.id',
);
assert.match(
  serviceSrc,
  /createRegenerateRun[\s\S]*?run:\s*runRow/,
  'createRegenerateRun 必须返回 run 行',
);

// 5. 业务不变量：旧 assistant message 收敛到 stopped。
assert.match(
  serviceSrc,
  /UPDATE messages[\s\S]*?SET status = 'stopped'[\s\S]*?WHERE id = \$1 AND workspace_id = \$2/,
  'createRegenerateRun 必须把旧 assistant message 收敛到 stopped',
);
// 6. partial unique 冲突 → ConversationActiveRunError。
assert.match(
  serviceSrc,
  /createRegenerateRun[\s\S]*?'23505'[\s\S]*?ConversationActiveRunError/,
  'createRegenerateRun 必须把 PG 23505 翻译为 ConversationActiveRunError',
);

// 7. PR-UI-1.0.5 F4：regenerate 路由必须经 runHandler 包裹，确保：
//   - 缺失/非法 Idempotency-Key 走 InputValidationError → 422 INPUT_VALIDATION_FAILED
//   - 所有响应（成功 / 错误 / 异常）都带 Request ID header
assert.match(
  sharedSrc,
  /regenerateMessage[\s\S]*?return\s+runHandler\(auth,\s*context,\s*deps,\s*async\s*\(\)\s*=>\s*\{[\s\S]*?throw\s+new\s+InputValidationError\('消息 ID 格式不正确。'\)/,
  'regenerateMessage 必须经 runHandler 包裹，并在 id 非 UUID 时抛 InputValidationError（→422）',
);
assert.match(
  sharedSrc,
  /readIdempotencyKey[\s\S]*?throw\s+new\s+InputValidationError/,
  'readIdempotencyKey 缺失/非法时必须抛 InputValidationError，由 runHandler → 422',
);
assert.match(
  sharedSrc,
  /function runHandler\([\s\S]*?InputValidationError[\s\S]*?INPUT_VALIDATION_FAILED[\s\S]*?applyRequestIdHeader/,
  'runHandler 必须把 InputValidationError 翻译为 422 + applyRequestIdHeader',
);
assert.match(
  sharedSrc,
  /function runHandler\([\s\S]*?INTERNAL_ERROR[\s\S]*?applyRequestIdHeader/,
  'runHandler 必须把未捕获异常翻译为 500 + applyRequestIdHeader',
);

console.log('✓ V2 regenerate route contract passed');
