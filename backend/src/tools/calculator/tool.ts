import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tool/registry.js';

/**
 * Calculator Tool。输入 / 输出 Schema 保持内联，因为本身很简单。
 * 未来若某 Tool 的 schema 复杂到要跨多个文件共用，请拆到 `tools/<id>/schema.ts`。
 */
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
      // 仅允许白名单字符的安全求值。
      const sanitized = expression.replace(/\s/g, '');
      if (!/^[\d+\-*/().]+$/.test(sanitized)) {
        return { result: '', error: '表达式包含非法字符，仅支持数字和 + - * / ( )。' };
      }
      // 拦截空串与恶意超长输入。
      if (sanitized.length === 0 || sanitized.length > 200) {
        return { result: '', error: '表达式长度无效（1-200 字符）。' };
      }
      // 用 Function 构造器在白名单范围内"沙箱"求值，不提供任何执行环境权限。
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

export const calculatorDefinition: ToolDefinition = {
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
};