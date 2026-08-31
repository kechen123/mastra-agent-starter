import 'dotenv/config';
import { initializeApp } from '../server/init.js';
import { streamAgent } from '../core/agent/runtime.js';
import { resolveSession } from '../infrastructure/auth/session.js';
import { ensurePersonalWorkspace } from '../modules/auth/workspace-context.js';

const args = process.argv.slice(2);
const knowledgeBaseId = args.find((arg) => arg.startsWith('--kb='))?.slice(5);
const question = args.filter((arg) => !arg.startsWith('--kb=')).join(' ') || '请概括已检索资料的核心内容。';

async function main(): Promise<void> {
  // The Core runtime depends on Agent / Tool / Skill registration side
  // effects that, in the HTTP server path, run via top-level imports in
  // `server/bootstrap.ts`. CLI scripts do not load that file, so we must
  // explicitly call the idempotent initializer first — otherwise
  // `streamAgent()` will report "Agent 不存在".
  await initializeApp();

  // V2.3.6 §5.1：CLI 路径没有 HTTP 请求可以走 `withAuthenticatedWorkspace`，
  // 因此通过 SESSION_TOKEN → resolveSession → ensurePersonalWorkspace
  // 显式解析已认证身份上下文，确保 workspaceId 与 HTTP 路径同源。
  const sessionToken = process.env.SESSION_TOKEN;
  if (!sessionToken) {
    console.error('缺少 SESSION_TOKEN 环境变量；CLI 脚本必须显式传入会话 token。');
    process.exitCode = 1;
    return;
  }
  const resolved = await resolveSession(sessionToken);
  if (!resolved) {
    console.error('SESSION_TOKEN 无效或会话已过期 / 用户已禁用。');
    process.exitCode = 1;
    return;
  }
  const { workspaceId } = await ensurePersonalWorkspace(resolved.user.id);

  const generator = streamAgent({
    workspaceId,
    agentId: knowledgeBaseId ? 'knowledge-base' : 'general-chat',
    prompt: question,
    knowledgeBaseId: knowledgeBaseId ?? null,
    history: [],
    abortSignal: new AbortController().signal,
  });
  let content = '';
  let citations: import('../types.js').Citation[] = [];
  let failed = false;
  for await (const event of generator) {
    if (event.type === 'delta') {
      content += event.text;
    } else if (event.type === 'done') {
      content = event.content;
      citations = event.citations;
    } else if (event.type === 'stopped') {
      content = event.content;
    } else if (event.type === 'error') {
      failed = true;
      content = event.error;
    }
  }
  if (failed) {
    console.error('执行失败：', content);
    process.exitCode = 1;
    return;
  }
  console.log(content);
  if (citations.length > 0) {
    console.log('\n引用：');
    for (const citation of citations) {
      console.log(`- ${citation.title}｜${citation.chapter}｜${citation.source}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
