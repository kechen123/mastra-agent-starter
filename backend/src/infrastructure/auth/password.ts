/**
 * 密码哈希 / 校验。
 *
 * 仅使用 Node 内置 `crypto.scrypt`、`randomBytes`、`timingSafeEqual`。
 * 不引入 bcrypt、argon2 等第三方依赖。
 *
 * 哈希字符串格式（self-describing）：
 *   scrypt$N=16384,r=8,p=1$<saltBase64Url>$<hashBase64Url>
 *
 * - salt 必须每次哈希都重新生成，禁止固定 salt。
 * - verify 必须使用 timingSafeEqual，禁止普通 `===` / `Buffer.equals`。
 * - 永远不向调用方返回哈希本身或派生参数；调用方负责把它写到数据库。
 *
 * 入参 password 长度上限 128、下限 12；长度校验由调用方（route / CLI）
 * 负责，这里只负责长度到位后再做哈希层面的二次检查。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const SCRYPT_N = 1 << 14;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LEN = 64;
export const SCRYPT_SALT_BYTES = 16;
export const HASH_PREFIX = `scrypt$${'N=' + SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;
const HASH_REGEX = /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

export class InvalidPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordError';
  }
}

export class InvalidPasswordHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordHashError';
  }
}

function assertPasswordLength(password: string): void {
  if (typeof password !== 'string') {
    throw new InvalidPasswordError('密码格式不正确。');
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new InvalidPasswordError(
      `密码长度必须在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 字符之间。`,
    );
  }
}

export function hashPassword(password: string): string {
  assertPasswordLength(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `${HASH_PREFIX}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  if (!HASH_REGEX.test(stored)) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const saltB64 = parts[2] ?? '';
  const hashB64 = parts[3] ?? '';
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEY_LEN) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, SCRYPT_KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function isPasswordHash(value: string): boolean {
  return typeof value === 'string' && HASH_REGEX.test(value);
}
