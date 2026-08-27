/**
 * 用户名规范化与长度校验。
 *
 * 用于登录、账号创建脚本等所有需要写入 username_normalized 的位置。
 *
 * 规则：
 *   * 去除首尾空白；
 *   * 全部转为小写；
 *   * 长度限制 3–64；
 *   * 仅允许 ASCII `[a-z0-9._-]`（小写化后再校验，避免输入大写数字等奇怪边界）。
 *
 * 不修改 `password` 字段。
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

export class InvalidUsernameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsernameError';
  }
}

export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidUsernameError('用户名格式不正确。');
  }
  const trimmed = raw.trim();
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
    throw new InvalidUsernameError(
      `用户名长度必须在 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 字符之间。`,
    );
  }
  const lowered = trimmed.toLowerCase();
  if (!USERNAME_PATTERN.test(lowered)) {
    throw new InvalidUsernameError('用户名只能包含字母、数字、点、下划线与连字符。');
  }
  return lowered;
}

export function isNormalizedUsername(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(value)
  );
}
