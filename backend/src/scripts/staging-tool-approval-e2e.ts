/**
 * PR-3.3.1 — Tool Approval staging 端到端验收脚本。
 *
 * 目标：在 staging 环境验证真实 Mastra 1.61 SDK + 真实模型 + 真实 HTTP/SSE
 * 跑完审批链路。三条场景：
 *   (1) approve   → resume stream 真实消费 → Run → completed；
 *   (2) decline   → resume stream 真实消费 → Run → failed；
 *   (3) timeout   → worker 把 pending 转 expired + scheduler 调
 *                   declineToolCall(reason='expired') + resume stream 消费 → Run
 *                   终态。
 *
 * 强制协议（缺一立即拒绝执行）：
 *   - RUN_STAGING_TOOL_APPROVAL_E2E=1
 *   - STAGING_E2E_BASE_URL（形如 https://staging.xuanshu.example）
 *   - STAGING_E2E_USERNAME / STAGING_E2E_PASSWORD（专用 staging 账号凭据）
 *
 * 安全边界：
 *   - **不**直接调用 state-machine / repository / run-executor / facade /
 *     evaluateToolPolicy —— 只走 HTTP API + SSE；
 *   - **不**DROP / TRUNCATE / RESET 任何表；只删本脚本本轮创建的
 *     conversation / message / approval / run 行；
 *   - **不**删用户、Workspace 或既有数据；
 *   - 拒绝打印密码 / token / DATABASE_URL / 模型密钥；
 *   - 服务健康 + Probe + Agent 必须**真**注册才能继续；失败立刻退出并报错，
 *     不 fallback 到 general-chat / knowledge-base。
 *
 * 不做的事：
 *   - 不启服务、不连真实数据库、不连真实 Provider —— 仅消费
 *     `STAGING_E2E_BASE_URL` 上正在运行的后端；
 *   - 不执行超时以外的 SDK 故障演练（W2 注入属 PR-3.3 范围之外的
 *     自动化容灾演练）；
 *   - 不做进程重启 / 跨实例竞争；
 *   - 不写业务表、不修改用户或 Workspace。
 *
 * 运行（不在本脚本自动执行；由 Codex 在 staging 环境手动触发）：
 *   cd backend
 *   RUN_STAGING_TOOL_APPROVAL_E2E=1 \
 *   STAGING_E2E_BASE_URL=https://staging.xuanshu.example \
 *   STAGING_E2E_USERNAME=<staging_user> \
 *   STAGING_E2E_PASSWORD='<staging_password>' \
 *   STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=30000 \
 *   npx tsx src/scripts/staging-tool-approval-e2e.ts
 */
import { randomUUID } from 'node:crypto';

const RUN = process.env.RUN_STAGING_TOOL_APPROVAL_E2E === '1';
const BASE_URL = process.env.STAGING_E2E_BASE_URL?.trim();
const USERNAME = process.env.STAGING_E2E_USERNAME?.trim();
const PASSWORD = process.env.STAGING_E2E_PASSWORD ?? '';
const TTL_MS_RAW = process.env.STAGING_APPROVAL_E2E_APPROVAL_TTL_MS?.trim();

interface Outcome {
  scenario: string;
  ok: boolean;
  reason: string;
  durationMs: number;
  runId?: string;
  approvalId?: string;
  finalRunStatus?: string;
  sseEvents?: string[];
  expiresAt?: string;
}

interface ApprovalSummary {
  approvalId: string;
  runId: string;
  finalStatus: string;
  expiresAt?: string;
}

const REDACTED = '<redacted>';

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`[staging-e2e] FAIL: ${msg}`);
  throw new Error(msg);
}

if (!RUN) {
  // eslint-disable-next-line no-console
  console.log('[staging-e2e] SKIP（未设置 RUN_STAGING_TOOL_APPROVAL_E2E=1）。');
  process.exit(0);
}
if (!BASE_URL) fail('STAGING_E2E_BASE_URL 未配置。');
if (!USERNAME) fail('STAGING_E2E_USERNAME 未配置。');
if (!PASSWORD) fail('STAGING_E2E_PASSWORD 未配置。');

let ttlMs: number | null = null;
if (TTL_MS_RAW && TTL_MS_RAW.length > 0) {
  const parsed = Number(TTL_MS_RAW);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 5 * 60_000) {
    fail(
      `STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=${REDACTED} 不合法：必须是 1000–300000 的整数。`,
    );
  }
  ttlMs = parsed;
}

// 唯一 e2e run 前缀：本脚本的所有 conversations / runs / approvals 都打
// 此标签，cleanup 阶段只动自己创建的对象；既有数据保持不动。
const RUN_PREFIX = `staging-e2e-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

interface LoginResult {
  cookie: string;
  user: { id: string; username: string; workspaceId: string };
}

async function login(): Promise<LoginResult> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: process.env.STAGING_E2E_ORIGIN ?? BASE_URL! },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (res.status !== 200) {
    fail(`登录失败：HTTP ${res.status}。`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) fail('登录响应缺少 Set-Cookie。');
  const cookieMatch = setCookie.match(/session=([^;]+)/);
  if (!cookieMatch) fail('Set-Cookie 未包含 session token。');
  const body = (await res.json()) as { user: { id: string; username: string; workspaceId: string } };
  return { cookie: `mastra_session=${cookieMatch[1]}`, user: body.user };
}

async function healthz(cookie: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/healthz`, { headers: { cookie } });
  if (res.status !== 200) fail(`健康检查失败：HTTP ${res.status}。`);
}

async function readiness(cookie: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/readyz`, { headers: { cookie } });
  if (res.status !== 200) fail(`就绪检查失败：HTTP ${res.status}。`);
}

async function listAgents(cookie: string): Promise<Array<{ id: string; toolIds: string[] }>> {
  const res = await fetch(`${BASE_URL}/agents`, { headers: { cookie } });
  if (res.status !== 200) fail(`/agents 失败：HTTP ${res.status}。`);
  return await res.json() as Array<{ id: string; toolIds: string[] }>;
}

async function listTools(cookie: string): Promise<Array<{ id: string; metadata: { destructive?: boolean } }>> {
  const res = await fetch(`${BASE_URL}/tools`, { headers: { cookie } });
  if (res.status !== 200) fail(`/tools 失败：HTTP ${res.status}。`);
  return await res.json() as Array<{ id: string; metadata: { destructive?: boolean } }>;
}

interface CreateConversationResult {
  conversationId: string;
  agentId: string;
}

async function createConversation(cookie: string, agentId: string, idemKey: string): Promise<CreateConversationResult> {
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: process.env.STAGING_E2E_ORIGIN ?? BASE_URL!, cookie, 'idempotency-key': idemKey },
    body: JSON.stringify({ agentId }),
  });
  if (res.status !== 201) fail(`/v1/conversations 失败：HTTP ${res.status}。`);
  const body = (await res.json()) as { id: string; agentId: string };
  return { conversationId: body.id, agentId: body.agentId };
}

interface CreateMessageResult {
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  eventsUrl: string;
}

async function createMessage(
  cookie: string,
  conversationId: string,
  content: string,
  idemKey: string,
): Promise<CreateMessageResult> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: process.env.STAGING_E2E_ORIGIN ?? BASE_URL!, cookie, 'idempotency-key': idemKey },
    body: JSON.stringify({ content }),
  });
  if (res.status !== 202) {
    const text = await res.text().catch(() => '<body 不可读>');
    fail(`/v1/conversations/:id/messages 失败：HTTP ${res.status} body=${text.slice(0, 200)}。`);
  }
  const body = (await res.json()) as CreateMessageResult;
  return body;
}

interface SseEvent {
  id?: number;
  event: string;
  data: unknown;
}

/**
 * 订阅 SSE 流，timeoutMs 毫秒内必须见到 expectedTypes 中的全部事件。
 *
 * timeout 场景下"全部"特指 approval-requested；approve / decline 场景
 * 特指 approval-requested + run-resumed + run-completed / run-failed /
 * run-stopped。
 */
async function collectSse(
  cookie: string,
  eventsUrl: string,
  expectedTypes: string[],
  timeoutMs: number,
): Promise<SseEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${eventsUrl}`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (res.status !== 200 || !res.body) fail(`SSE 连接失败：HTTP ${res.status}。`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    const seen = new Set<string>();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSseFrame(raw);
        if (!evt) continue;
        events.push(evt);
        seen.add(evt.event);
        if (expectedTypes.some((t) => seen.has(t)) || ['run-completed', 'run-failed', 'run-stopped'].includes(evt.event)) {
          await reader.cancel();
          return events;
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

function parseSseFrame(raw: string): SseEvent | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event) return null;
  let data: unknown = null;
  if (dataLines.length > 0) {
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      data = dataLines.join('\n');
    }
  }
  return { id, event, data };
}

async function pollForPendingApproval(
  runId: string,
  cookie: string,
  timeoutMs: number,
): Promise<{ approvalId: string; toolName: string; toolCallId: string; expiresAt: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/v1/approvals`, { headers: { cookie } });
    if (res.status !== 200) fail(`/v1/approvals 失败：HTTP ${res.status}。`);
    const body = (await res.json()) as { approvals: Array<{ id: string; runId: string; status: string; toolId: string; toolCallId: string; expiresAt: string }> };
    const found = body.approvals.find((a) => a.runId === runId && a.status === 'pending');
    if (found) return { approvalId: found.id, toolName: found.toolId, toolCallId: found.toolCallId, expiresAt: found.expiresAt };
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`轮询 ${timeoutMs}ms 仍未见 run ${runId} 的 pending approval。`);
}

async function resolveApproval(
  cookie: string,
  approvalId: string,
  decision: 'approve' | 'decline',
): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/approvals/${approvalId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: process.env.STAGING_E2E_ORIGIN ?? BASE_URL!, cookie },
    body: JSON.stringify({ decision }),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '<body 不可读>');
    fail(`/v1/approvals/${REDACTED}/resolve 失败：HTTP ${res.status} body=${text.slice(0, 200)}。`);
  }
}

async function deleteConversation(cookie: string, conversationId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/conversations/${conversationId}`, {
    method: 'DELETE',
    headers: { cookie, origin: process.env.STAGING_E2E_ORIGIN ?? BASE_URL! },
  });
  if (!response.ok) console.warn(`Cleanup failed: ${conversationId} HTTP ${response.status}`);
}

async function runApproveScenario(login: LoginResult): Promise<Outcome> {
  const start = Date.now();
  const scenario = 'approve';
  const nonce = `e2e-${RUN_PREFIX}-approve-${randomUUID().slice(0, 8)}`;
  const idemConv = randomUUID();
  const idemMsg = randomUUID();
  try {
    const conv = await createConversation(login.cookie, 'staging-approval-probe', idemConv);
    const msg = await createMessage(login.cookie, conv.conversationId, nonce, idemMsg);

    // 第一阶段：等到 approval-requested
    const firstEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['approval-requested'],
      Math.max(120_000, (ttlMs ?? 0) + 60_000),
    );
    const approvalEvent = firstEvents.find((e) => e.event === 'approval-requested');
    if (!approvalEvent) return failOutcome(scenario, start, 'SSE 未收到 approval-requested。');
    const approval = approvalEvent.data as { approvalId: string; runId: string; toolName: string; toolCallId: string; expiresAt: string };

    const restartPauseMs = Number(process.env.STAGING_E2E_RESTART_PAUSE_MS ?? 0);
    if (!Number.isInteger(restartPauseMs) || restartPauseMs < 0 || restartPauseMs > 120_000) {
      throw new Error('STAGING_E2E_RESTART_PAUSE_MS must be between 0 and 120000');
    }
    if (restartPauseMs > 0) {
      console.log(`[restart-checkpoint] runId=${msg.runId} approvalId=${approval.approvalId} pauseMs=${restartPauseMs}`);
      await new Promise((resolve) => setTimeout(resolve, restartPauseMs));
    }
    // 调用 resolve API
    await resolveApproval(login.cookie, approval.approvalId, 'approve');

    // 第二阶段：等到 run-completed / run-failed / run-stopped
    const secondEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['run-completed', 'run-failed', 'run-stopped'],
      Math.max(60_000, (ttlMs ?? 0) + 60_000),
    );
    const terminal = secondEvents.find((e) => e.event === 'run-completed' || e.event === 'run-failed' || e.event === 'run-stopped');
    if (!terminal) {
      return failOutcome(scenario, start, 'approve 后未收到 run 终态事件。', {
        runId: msg.runId,
        approvalId: approval.approvalId,
        sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
        expiresAt: approval.expiresAt,
      });
    }
    const finalRunStatus = terminal.event === 'run-completed' ? 'completed' : terminal.event === 'run-failed' ? 'failed' : 'stopped';
    if (finalRunStatus !== 'completed') {
      return failOutcome(scenario, start, `approve 后 Run 终态=${finalRunStatus}，期望 completed。`, {
        runId: msg.runId,
        approvalId: approval.approvalId,
        finalRunStatus,
        sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
        expiresAt: approval.expiresAt,
      });
    }
    const toolCompleted = secondEvents.find((event) => event.event === 'tool-call-completed');
    const toolResult = toolCompleted?.data as { toolCallId?: string; output?: { echo?: string } } | undefined;
    if (toolResult?.toolCallId !== approval.toolCallId || toolResult.output?.echo !== nonce) {
      return failOutcome(scenario, start, 'Run completed，但没有匹配 toolCallId + nonce 的工具完成事件。保留本轮会话供排查。', {
        runId: msg.runId, approvalId: approval.approvalId, finalRunStatus,
        sseEvents: [...firstEvents, ...secondEvents].map((event) => event.event),
      });
    }
    await deleteConversation(login.cookie, conv.conversationId);
    return {
      scenario,
      ok: true,
      reason: 'approval-requested → approve → resume stream 消费 → Run completed。',
      durationMs: Date.now() - start,
      runId: msg.runId,
      approvalId: approval.approvalId,
      finalRunStatus,
      sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
      expiresAt: approval.expiresAt,
    };
  } catch (err) {
    return failOutcome(scenario, start, `异常：${(err as Error).message}`);
  }
}

async function runDeclineScenario(login: LoginResult): Promise<Outcome> {
  const start = Date.now();
  const scenario = 'decline';
  const nonce = `e2e-${RUN_PREFIX}-decline-${randomUUID().slice(0, 8)}`;
  const idemConv = randomUUID();
  const idemMsg = randomUUID();
  try {
    const conv = await createConversation(login.cookie, 'staging-approval-probe', idemConv);
    const msg = await createMessage(login.cookie, conv.conversationId, nonce, idemMsg);
    const firstEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['approval-requested'],
      Math.max(120_000, (ttlMs ?? 0) + 60_000),
    );
    const approvalEvent = firstEvents.find((e) => e.event === 'approval-requested');
    if (!approvalEvent) return failOutcome(scenario, start, 'SSE 未收到 approval-requested。');
    const approval = approvalEvent.data as { approvalId: string; runId: string };
    await resolveApproval(login.cookie, approval.approvalId, 'decline');
    const secondEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['run-completed', 'run-failed', 'run-stopped'],
      Math.max(60_000, (ttlMs ?? 0) + 60_000),
    );
    const terminal = secondEvents.find((e) => e.event === 'run-completed' || e.event === 'run-failed' || e.event === 'run-stopped');
    if (!terminal) {
      return failOutcome(scenario, start, 'decline 后未收到 run 终态事件。', {
        runId: msg.runId,
        approvalId: approval.approvalId,
        sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
      });
    }
    const finalRunStatus = terminal.event === 'run-completed' ? 'completed' : terminal.event === 'run-failed' ? 'failed' : 'stopped';
    if (finalRunStatus !== 'completed') throw new Error(`Decline resume failed: ${finalRunStatus}`);
    const finalView = await (await fetch(`${BASE_URL}/v1/approvals/${approval.approvalId}`, { headers: { cookie: login.cookie } })).json() as { approval: { status: string } };
    if (finalView.approval.status !== 'declined') throw new Error('Approval is not declined');
    await deleteConversation(login.cookie, conv.conversationId);
    return {
      scenario,
      ok: true,
      reason: 'approval-requested → decline → resume stream 消费 → Run 终态。',
      durationMs: Date.now() - start,
      runId: msg.runId,
      approvalId: approval.approvalId,
      finalRunStatus,
      sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
    };
  } catch (err) {
    return failOutcome(scenario, start, `异常：${(err as Error).message}`);
  }
}

async function runTimeoutScenario(login: LoginResult): Promise<Outcome> {
  const start = Date.now();
  const scenario = 'timeout';
  if (ttlMs === null) {
    return failOutcome(scenario, start, 'timeout 场景必须设置 STAGING_APPROVAL_E2E_APPROVAL_TTL_MS。');
  }
  const nonce = `e2e-${RUN_PREFIX}-timeout-${randomUUID().slice(0, 8)}`;
  const idemConv = randomUUID();
  const idemMsg = randomUUID();
  try {
    const conv = await createConversation(login.cookie, 'staging-approval-probe', idemConv);
    const msg = await createMessage(login.cookie, conv.conversationId, nonce, idemMsg);
    const firstEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['approval-requested'],
      Math.max(120_000, ttlMs + 60_000),
    );
    const approvalEvent = firstEvents.find((e) => e.event === 'approval-requested');
    if (!approvalEvent) return failOutcome(scenario, start, 'SSE 未收到 approval-requested。');
    const approval = approvalEvent.data as { approvalId: string; runId: string; expiresAt: string };

    // 等到 TTL + worker tick + scheduler 调 SDK + resume stream 收尾。
    // TTL + 60s 容忍窗口足够覆盖：
    //   - 15s timeout worker tick
    //   - 1s resume scheduler tick
    //   - 真实 Mastra SDK 端响应延迟
    const secondEvents = await collectSse(
      login.cookie,
      msg.eventsUrl,
      ['run-completed', 'run-failed', 'run-stopped'],
      Math.max(60_000, ttlMs + 60_000),
    );
    const terminal = secondEvents.find((e) => e.event === 'run-completed' || e.event === 'run-failed' || e.event === 'run-stopped');
    if (!terminal) {
      return failOutcome(scenario, start, 'timeout 后未收到 run 终态事件。', {
        runId: msg.runId,
        approvalId: approval.approvalId,
        sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
        expiresAt: approval.expiresAt,
      });
    }
    // 验证 approval 行已变 expired —— 仅通过 SSE 事件观察 run 终态；approval
    // 状态由 /v1/approvals 列表反映（resolver_id 应为 system-approval-worker）。
    const approvalView = await fetch(`${BASE_URL}/v1/approvals/${approval.approvalId}`, {
      headers: { cookie: login.cookie },
    });
    if (approvalView.status !== 200) {
      return failOutcome(scenario, start, `读取 approval 失败 HTTP ${approvalView.status}。`);
    }
    const approvalBody = (await approvalView.json()) as { approval: { status: string; resolverId: string } };
    const finalStatus = approvalBody.approval.status;
    const finalRunStatus = terminal.event === 'run-completed' ? 'completed' : terminal.event === 'run-failed' ? 'failed' : 'stopped';
    const isExpired = finalStatus === 'expired' && approvalBody.approval.resolverId === '00000000-0000-0000-0000-0000000000a1';
    if (finalRunStatus !== 'completed') throw new Error(`Timeout resume failed: ${finalRunStatus}`);
    await deleteConversation(login.cookie, conv.conversationId);
    if (!isExpired) {
      return failOutcome(scenario, start, `timeout 后 approval.status=${finalStatus}，期望 expired。`, {
        runId: msg.runId,
        approvalId: approval.approvalId,
        finalRunStatus,
        sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
        expiresAt: approval.expiresAt,
      });
    }
    return {
      scenario,
      ok: true,
      reason: `pending → expired（resolver=system-approval-worker）→ scheduler 调 declineToolCall(reason='expired') → Run ${finalRunStatus}。`,
      durationMs: Date.now() - start,
      runId: msg.runId,
      approvalId: approval.approvalId,
      finalRunStatus,
      sseEvents: [...firstEvents, ...secondEvents].map((e) => e.event),
      expiresAt: approval.expiresAt,
    };
  } catch (err) {
    return failOutcome(scenario, start, `异常：${(err as Error).message}`);
  }
}

function failOutcome(
  scenario: string,
  start: number,
  reason: string,
  extra: Partial<Outcome> = {},
): Outcome {
  return { scenario, ok: false, reason, durationMs: Date.now() - start, ...extra };
}

function summarizeForLog(o: Outcome): Record<string, unknown> {
  // 不打印 approval token / 凭据；只脱敏展示关键事件。
  return {
    scenario: o.scenario,
    ok: o.ok,
    durationMs: o.durationMs,
    runId: o.runId ?? null,
    approvalId: o.approvalId ?? null,
    finalRunStatus: o.finalRunStatus ?? null,
    sseEvents: o.sseEvents ?? [],
    expiresAt: o.expiresAt ?? null,
    reason: o.reason,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[staging-e2e] 启动；RUN_PREFIX=${RUN_PREFIX} ttlMs=${ttlMs ?? '<default 5min>'}`);

  const session = await login();
  // eslint-disable-next-line no-console
  console.log(`[staging-e2e] 登录成功：user=${session.user.username} workspaceId=${session.user.workspaceId}`);

  // 健康 + 就绪检查
  await healthz(session.cookie);
  await readiness(session.cookie);

  // 校验 Probe + Agent 真的启用——绝不允许 fallback。
  const agents = await listAgents(session.cookie);
  if (!agents.some((a) => a.id === 'staging-approval-probe')) {
    fail('Agent `staging-approval-probe` 未在 /agents 暴露；ENABLE_STAGING_APPROVAL_PROBE 可能未启用。');
  }
  const tools = await listTools(session.cookie);
  const probeTool = tools.find((t) => t.id === 'staging-approval-probe');
  if (!probeTool) fail('Tool `staging-approval-probe` 未在 /tools 暴露。');
  if (!probeTool.metadata.destructive) {
    fail('Tool `staging-approval-probe` metadata.destructive 必须为 true；evaluator 必须判为 requires-approval。');
  }

  const outcomes: Outcome[] = [];
  outcomes.push(await runApproveScenario(session));
  if (process.env.STAGING_E2E_APPROVE_ONLY !== '1') {
    outcomes.push(await runDeclineScenario(session));
    outcomes.push(await runTimeoutScenario(session));
  }

  // eslint-disable-next-line no-console
  console.log('\n[staging-e2e] 验收报告：');
  for (const o of outcomes) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summarizeForLog(o), null, 2));
  }
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[staging-e2e] FAIL：${failed.length}/${outcomes.length} 场景未通过。`);
    process.exitCode = 1;
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[staging-e2e] PASS：${outcomes.length}/${outcomes.length} 场景通过。`);
}

await main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[staging-e2e] 未捕获异常：', err);
  process.exitCode = 2;
});
