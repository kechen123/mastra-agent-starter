/**
 * 本地用户创建 CLI。
 *
 * 用法：
 *   npm run users:create -- --username <username>
 *
 * 行为约束（与设计保持一致）：
 *   * 仅创建账号；不创建会话、不登录、不修改现有账号。
 *   * 密码**两次**通过标准输入输入，不接受命令行参数（避免 shell history）。
 *   * 用户名已存在时立即报错退出，不覆盖。
 *   * 密码输入**不回显**（按字符打印 `*` 掩码 + Enter 终止）。在非 TTY
 *     环境下直接拒绝，避免在 CI/重定向管道里明文落地。
 *   * 不输出 `password_hash`、原始密码或数据库连接敏感信息。
 *   * 不在错误响应里回显密码，仅提示"两次密码不一致 / 长度不合法"。
 */
import 'dotenv/config';
import { stdin, stdout, exit } from 'node:process';
import { getDatabasePool } from '../infrastructure/database/pool.js';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../infrastructure/auth/password.js';
import { normalizeUsername } from '../infrastructure/auth/username.js';

function parseUsernameArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('请通过 `--username <username>` 提供用户名。');
      }
      return next;
    }
    if (arg && arg.startsWith('--username=')) {
      const value = arg.slice('--username='.length);
      if (!value) {
        throw new Error('请通过 `--username <username>` 提供用户名。');
      }
      return value;
    }
    if (arg && arg.startsWith('--username') && arg !== '--username') {
      // 宽容匹配 `--username=<u>` 由上一种分支处理；这里只拒 `--username`。
      throw new Error('请通过 `--username <username>` 提供用户名。');
    }
  }
  throw new Error('缺少必填参数：--username <username>。');
}

/**
 * 读取单行无回显输入：在 raw mode 下逐字符读 stdin，遇到 \r/\n 结束；每个
 * 普通字符回写一个 `*` 作为视觉掩码，最终整理字符串。Ctrl-C / Ctrl-D 抛错。
 *
 * 为什么不用 `readline/promises` 的 `terminal: true`：readline 在 Windows
 * 上仍然会把键入字符回显到终端（取决于 conhost）。直接接管 raw 字节是
 * 唯一跨平台稳定的隐藏方案。
 *
 * 退出路径（Enter、Ctrl-C、Ctrl-D、setRawMode 失败）必须保证：
 *   1. 移除 'data' 监听器；
 *   2. 恢复 entry 时的原始 raw 状态（`wasRaw`），不是当前 `isRaw`——因为
 *      进入循环后 stdin.isRaw 已经被设为 true，原条件判断会失败；
 *   3. 调用 stdin.pause() 让后续 stdin 重新进入正常事件循环。
 */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error('users:create 必须在交互式终端中运行（stdin 不是 TTY）。'));
      return;
    }
    const wasRaw = stdin.isRaw;
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        // 恢复到进入函数前的原始 raw 状态；如果原本就是 raw mode，
        // 保持 true；否则把 raw mode 关掉。
        if (stdin.isTTY && stdin.isRaw !== wasRaw) {
          stdin.setRawMode(wasRaw);
        }
      } catch {
        // setRawMode 在非 TTY 或不支持的环境下可能抛错；吞掉即可，
        // 终端状态会在下一次进入 raw mode / 进程退出时归位。
      }
      stdin.pause();
    };

    const settle = (ok: boolean, value: string) => {
      if (settled) return;
      settled = true;
      stdout.write('\n');
      cleanup();
      if (ok) resolve(value);
      else reject(new Error(value));
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          settle(true, buffer);
          return;
        }
        if (code === 0x03) {
          settle(false, '用户已中断。');
          return;
        }
        if (code === 0x04 && buffer.length === 0) {
          settle(false, '用户已中断。');
          return;
        }
        if (code === 0x08 || code === 0x7f) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (code < 0x20) {
          // 其它控制字符直接忽略，不写入缓冲区也不回显。
          continue;
        }
        if (buffer.length >= PASSWORD_MAX_LENGTH + 32) continue;
        buffer += ch;
        stdout.write('*');
      }
    };

    try {
      stdin.resume();
      if (stdin.isTTY) stdin.setRawMode(true);
    } catch (err) {
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    stdin.on('data', onData);
    stdout.write(prompt);
  });
}

async function readPasswordTwice(label: string): Promise<string> {
  const first = await readHiddenLine(`${label} 密码：`);
  const second = await readHiddenLine(`${label} 再次输入密码：`);
  if (first !== second) {
    throw new Error('两次输入的密码不一致。');
  }
  if (first.length < PASSWORD_MIN_LENGTH || first.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`密码长度必须在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 字符之间。`);
  }
  return first;
}

async function main(): Promise<void> {
  const rawUsername = parseUsernameArg(process.argv.slice(2));
  let username: string;
  try {
    username = normalizeUsername(rawUsername);
  } catch (err) {
    console.error((err as Error).message);
    exit(2);
    return;
  }

  let password: string;
  try {
    password = await readPasswordTwice(username);
  } catch (err) {
    console.error((err as Error).message);
    exit(2);
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = hashPassword(password);
  } catch (err) {
    console.error((err as Error).message);
    exit(2);
    return;
  }

  const pool = getDatabasePool();
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM app_users WHERE username_normalized = $1 LIMIT 1`,
    [username],
  );
  if (existing.rows[0]) {
    console.error(`用户名 "${username}" 已存在，未创建新账号。`);
    exit(1);
    return;
  }

  await pool.query(
    `INSERT INTO app_users (username, username_normalized, password_hash)
     VALUES ($1, $2, $3)`,
    [rawUsername.trim(), username, passwordHash],
  );
  console.log(`已创建本地用户 "${username}"。`);
}

main().catch((err) => {
  console.error('users:create 失败：', err);
  exit(1);
});