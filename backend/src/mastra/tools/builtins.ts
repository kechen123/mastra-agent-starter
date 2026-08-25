import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { registerTool } from './registry.js';

const calculatorTool = createTool({
  id: 'calculator',
  description: '计算数学表达式的结果。支持 + - * / 和括号。',
  inputSchema: z.object({
    expression: z.string().describe('数学表达式，例如 "2 + 3 * 4"'),
  }),
  outputSchema: z.object({
    result: z.union([z.number(), z.string()]),
    error: z.string().optional(),
  }),
  execute: async ({ expression }, { abortSignal }) => {
    if (abortSignal?.aborted) {
      return { result: '', error: '已取消' };
    }
    try {
      // Whitelist-only safe evaluation
      const sanitized = expression.replace(/\s/g, '');
      if (!/^[\d+\-*/().]+$/.test(sanitized)) {
        return { result: '', error: '表达式包含非法字符，仅支持数字和 + - * / ( )。' };
      }
      // Prevent empty or maliciously long inputs
      if (sanitized.length === 0 || sanitized.length > 200) {
        return { result: '', error: '表达式长度无效（1-200 字符）。' };
      }
      // Use Function constructor for sandboxed evaluation of whitelisted expressions
      const fn = new Function(`return (${sanitized})`);
      const result = fn();
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return { result: '', error: '计算结果无效。' };
      }
      return { result };
    } catch {
      return { result: '', error: '表达式计算失败，请检查语法。' };
    }
  },
});

registerTool({
  id: 'calculator',
  displayName: 'Calculator',
  description: '计算数学表达式的结果。支持 + - * / 和括号。',
  tool: calculatorTool,
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresRuntime: false,
  },
});

const getCurrentTimeTool = createTool({
  id: 'get-current-time',
  description: '获取当前日期和时间，包括时区信息。',
  inputSchema: z.object({
    timezone: z.string().optional().describe('时区，例如 "Asia/Shanghai"，默认为本地时区'),
  }),
  outputSchema: z.object({
    datetime: z.string(),
    timezone: z.string(),
    iso: z.string(),
  }),
  execute: async ({ timezone }) => {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const now = new Date();
    const iso = now.toISOString();
    const datetime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(now);
    return { datetime, timezone: tz, iso };
  },
});

registerTool({
  id: 'get-current-time',
  displayName: 'Get Current Time',
  description: '获取当前日期和时间，包括时区信息。',
  tool: getCurrentTimeTool,
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: false,
    openWorld: false,
    requiresRuntime: false,
  },
});
