/**
 * username.ts fixture.
 */
import assert from 'node:assert/strict';
import {
  normalizeUsername,
  isNormalizedUsername,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  InvalidUsernameError,
} from '../../src/infrastructure/auth/username.js';

// 1. trim + lowercase
{
  assert.equal(normalizeUsername('  Alice_2  '), 'alice_2');
  assert.equal(normalizeUsername('Bob.Dot'), 'bob.dot');
  assert.equal(normalizeUsername('Carol-Dash'), 'carol-dash');
}

// 2. 长度下限
{
  let caught = false;
  try { normalizeUsername('ab'); } catch (err) { caught = err instanceof InvalidUsernameError; }
  assert.equal(caught, true);
}

// 3. 长度上限
{
  let caught = false;
  try { normalizeUsername('a'.repeat(USERNAME_MAX_LENGTH + 1)); } catch (err) { caught = err instanceof InvalidUsernameError; }
  assert.equal(caught, true);
}

// 4. 非法字符拒
{
  for (const raw of ['alice!', 'a@b', 'bob space', '中文用户名', 'name/slash']) {
    let caught = false;
    try { normalizeUsername(raw); } catch (err) { caught = err instanceof InvalidUsernameError; }
    assert.equal(caught, true, `reject ${raw}`);
  }
}

// 5. 输入为非字符串拒
{
  let caught = false;
  try { normalizeUsername(123 as unknown as string); } catch (err) { caught = err instanceof InvalidUsernameError; }
  assert.equal(caught, true);
  try { normalizeUsername(undefined as unknown as string); } catch (err) { caught = err instanceof InvalidUsernameError; }
  assert.equal(caught, true);
}

// 6. isNormalizedUsername 仅在合法情况下为 true
{
  assert.equal(isNormalizedUsername('alice'), true);
  assert.equal(isNormalizedUsername('a'), false);
  assert.equal(isNormalizedUsername('alice!'), false);
}

console.log('  ✓ username fixtures passed');
