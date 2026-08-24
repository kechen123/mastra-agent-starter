import 'dotenv/config';
import { answerGeneral, answerWithKnowledge } from '../mastra/services/ask.js';

const args = process.argv.slice(2);
const knowledgeBaseId = args.find((arg) => arg.startsWith('--kb='))?.slice(5);
const question = args.filter((arg) => !arg.startsWith('--kb=')).join(' ') || '请概括已检索资料的核心内容。';

async function main(): Promise<void> {
  if (knowledgeBaseId) {
    const result = await answerWithKnowledge(question, knowledgeBaseId);
    console.log(result.answer);
    console.log('\n引用：');
    for (const citation of result.citations) {
      console.log(`- ${citation.title}｜${citation.chapter}｜${citation.source}`);
    }
  } else {
    const result = await answerGeneral(question);
    console.log(result.answer);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
