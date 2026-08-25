import 'dotenv/config';
import { streamAgent } from '../mastra/agents/runtime.js';

const args = process.argv.slice(2);
const knowledgeBaseId = args.find((arg) => arg.startsWith('--kb='))?.slice(5);
const question = args.filter((arg) => !arg.startsWith('--kb=')).join(' ') || '请概括已检索资料的核心内容。';

async function main(): Promise<void> {
  const generator = streamAgent(
    knowledgeBaseId ? 'knowledge-base' : 'general-chat',
    question,
    knowledgeBaseId ?? null,
    [],
    new AbortController().signal,
  );
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
