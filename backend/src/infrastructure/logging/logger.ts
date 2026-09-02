/**
 * 结构化日志：阶段 2 §6.5 引入 pino，替换 `console.error` / `console.log`
 * 路径上的散写。
 *
 * 关键约束：
 *   - 仅 pino 这一项新增依赖；不引入 winston / bunyan / 自研 wrapper；
 *   - 字段以 architecture-v2.md §6.5 为准：requestId / workspaceId /
 *     userId / conversationId / runId / provider / model / durationMs /
 *     tokens / errorCode；
 *   - **禁止**写入敏感字段：cookie、token、password、Authorization 头、
 *     完整文档正文、Tool I/O 原文；
 *   - 默认 level = 'info'；生产可由 `LOG_LEVEL` 覆盖；
 *   - 默认输出 JSON 行；本机开发时如设 `LOG_PRETTY=1` 走 pretty 模式。
 */
import { pino } from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  'password_hash',
  'token',
  'session_token',
  'authorization',
];

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === '1';

export const logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
  base: {
    app: 'xuanshu-agent',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;