import 'dotenv/config';
import { executeAgent } from '../mastra/agents/runtime.js';

const args = process.argv.slice(2);
const knowledgeBaseId = args.find((arg) => arg.startsWith('--kb='))?.slice(5);
const question = args.filter((arg) => !arg.startsWith('--kb=')).join(' ') || '请概括已检索资料的核心内容。';

async function main(): Promise<void> {
  const result = await executeAgent(
    knowledgeBaseId ? 'knowledge-base' : 'general-chat',
    question,
    knowledgeBaseId,
  );
  if (result.status === 'failed') {
    console.error('执行失败：', result.content);
    process.exitCode = 1;
    return;
  }
  console.log(result.content);
  if (result.citations.length > 0) {
    console.log('\n引用：');
    for (const citation of result.citations) {
      console.log(`- ${citation.title}｜${citation.chapter}｜${citation.source}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
