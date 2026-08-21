import 'dotenv/config';
import { answerWithCitations } from '../mastra/services/ask.js';

const question = process.argv.slice(2).join(' ') || '《道德经》中的无为是什么意思？';
const result = await answerWithCitations(question);
console.log(result.answer);
console.log('\n引用：');
for (const citation of result.citations) {
  console.log(`- ${citation.title}｜${citation.chapter}｜${citation.version ?? '版本未标注'}｜${citation.source}`);
}
