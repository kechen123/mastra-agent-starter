/**
 * password.ts fixture.
 *
 * Importing this module runs the assertions at module load time and exits
 * non-zero on any failure (Node process.exit).
 */
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isPasswordHash,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  InvalidPasswordError,
} from '../../src/infrastructure/auth/password.js';

// 1. 正常 hash + verify
{
  const password = 'correct-horse-battery';
  const hashed = hashPassword(password);
  assert.match(hashed, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/, 'hash format');
  assert.equal(verifyPassword(password, hashed), true, 'verify ok');
}

// 2. 错误密码应当失败
{
  const password = 'correct-horse-battery';
  const hashed = hashPassword(password);
  assert.equal(verifyPassword('wrong-horse-battery', hashed), false, 'wrong password rejected');
}

// 3. 同密码两次 hash 应得到不同 salt（固定 salt 反例）
{
  const password = 'a-fixed-password-12!';
  const h1 = hashPassword(password);
  const h2 = hashPassword(password);
  assert.notEqual(h1, h2, 'two hashes have different salts');
  assert.equal(verifyPassword(password, h1), true);
  assert.equal(verifyPassword(password, h2), true);
}

// 4. 长度下限
{
  let caught = false;
  try { hashPassword('short'); } catch (err) { caught = err instanceof InvalidPasswordError; }
  assert.equal(caught, true, 'too-short password rejected');
}

// 5. 长度上限
{
  let caught = false;
  try { hashPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1)); } catch (err) { caught = err instanceof InvalidPasswordError; }
  assert.equal(caught, true, 'too-long password rejected');
}

// 6. verify 接受长度边界
{
  const minPassword = 'a'.repeat(PASSWORD_MIN_LENGTH);
  const hashed = hashPassword(minPassword);
  assert.equal(verifyPassword(minPassword, hashed), true);
  assert.equal(verifyPassword(minPassword.slice(0, -1), hashed), false);
}

// 7. isPasswordHash 校验格式
{
  const valid = hashPassword('a-strong-password!');
  assert.equal(isPasswordHash(valid), true, 'valid hash format recognized');
  assert.equal(isPasswordHash('scrypt$bogus$'), false, 'malformed rejected');
  assert.equal(isPasswordHash(''), false, 'empty rejected');
}

// 8. verify 对篡改过的 hash 也安全失败
{
  const valid = hashPassword('a-strong-password!');
  // 修改中间位置字符：base64url 每 4 字符对应 3 字节，改中段能命中整字节变化；
  // 改最后一字符只会改变最后一字节的尾部 2 bit，不保证与原值不同。
  const mid = Math.floor(valid.length / 2);
  const broken = valid.slice(0, mid) + (valid[mid] === 'A' ? 'B' : 'A') + valid.slice(mid + 1);
  assert.notEqual(broken, valid);
  assert.equal(verifyPassword('a-strong-password!', broken), false);
}

console.log('  ✓ password fixtures passed');
