import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tool/registry.js';

/**
 * Tool 模板 —— 复制本文件到 `backend/src/tools/<your-id>/tool.ts` 后调整：
 *
 *   - Tool 的 id / displayName / description；
 *   - 输入 / 输出 Zod Schema；
 *   - execute() 实现；
 *   - ToolDefinition 的 metadata 标志位。
 *
 * 若 schema 复杂到要跨多个文件共用，请拆到 `tools/<your-id>/schema.ts`。
 */
const templateTool = createTool({
  id: 'template-tool',
  description: '占位 Tool，请替换为真实描述。',
  inputSchema: z.object({
    input: z.string().describe('占位输入参数'),
  }),
  outputSchema: z.object({
    output: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ input }, { abortSignal }) => {
    if (abortSignal?.aborted) {
      return { output: '', error: '已取消' };
    }
    return { output: `template received: ${input}` };
  },
});

/**
 * 模板 ToolDefinition。metadata 标志会显示在前端 Capability UI 上，
 * 帮用户理解 Tool 的副作用边界：
 *
 *   - `readOnly`：只读，不修改任何状态；
 *   - `destructive`：可能修改 / 删除用户可见状态；
 *   - `idempotent`：相同输入重复调用安全；
 *   - `openWorld`：会触达外部服务（网络 / 文件系统）；
 *   - `requiresRuntime`：依赖外部运行时（如 Python）。
 *
 * 严禁注册本模板，详见 `_template/README.md`。
 */
export const templateDefinition: ToolDefinition = {
  id: 'template-tool',
  displayName: 'Template Tool',
  description: '占位 Tool，请替换为真实描述。',
  tool: templateTool,
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresRuntime: false,
  },
};