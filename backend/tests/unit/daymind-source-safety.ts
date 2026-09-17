import { isRecordIntent } from '../../src/modules/sources/record-intent.js';
import { scanSensitiveData } from '../../src/modules/sources/sensitive-data-scanner.js';

let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

console.log('[daymind-source] intent and secret boundary');
assert('识别常见记录表达', isRecordIntent('这是项目资料，记录下来。'));
assert('识别保存表达', isRecordIntent('帮我保存这段内容，以后记得。'));
assert('否定记录不误判', !isRecordIntent('不要记录这句话。'));

const password = scanSensitiveData('服务器地址：example.com\n密码：abc123456');
assert('密码被识别', password.hasSensitiveData && password.kinds.includes('password'));
assert('密码明文不在脱敏结果', !password.redactedContent.includes('abc123456'));
const bearer = scanSensitiveData('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
assert('Bearer 被识别', bearer.hasSensitiveData && bearer.kinds.includes('bearer_token'));
assert('Bearer 明文不在脱敏结果', !bearer.redactedContent.includes('abcdefghijklmnopqrstuvwxyz'));
if (failed > 0) process.exitCode = 1;
