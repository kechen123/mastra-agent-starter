# Tool 系统文档

## Tool Registry

`backend/src/mastra/tools/registry.ts` 实现了轻量级的 Tool 注册中心：

- `registerTool(definition: ToolDefinition)`: 注册工具，重复 ID 会抛出异常
- `getToolDefinition(id)`: 获取工具定义
- `listToolDefinitions()`: 列出所有已注册工具
- `resolveTools(ids)`: 根据 ID 列表返回工具实例映射（用于注入 Agent）
- `resolveToolIds(agentToolIds, allowedTools)`: 在 agent 配置和允许列表之间取交集

## ToolDefinition 结构

```typescript
interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  tool: ReturnType<typeof createTool>;
  metadata: {
    readOnly: boolean;        // 是否只读
    destructive: boolean;     // 是否具有破坏性
    idempotent: boolean;      // 是否幂等
    openWorld: boolean;       // 是否访问外部世界
    requiresRuntime?: boolean; // 是否需要运行时环境
  };
}
```

## 内置工具

### calculator

**ID**: `calculator`

安全的数学表达式计算器。

- 输入: `{ expression: string }`
- 输出: `{ result: number | string, error?: string }`
- 安全机制:
  - 去除所有空白字符
  - 正则白名单: `/^[\d+\-*/().]+$/`，仅允许数字和 `+-*/().`
  - 长度限制: 200 字符
  - 使用 `new Function()` 执行，拒绝任何代码注入
- 错误处理: 表达式无效或过长时返回 `error` 字段，不抛出异常

### get-current-time

**ID**: `get-current-time`

获取当前日期时间。

- 输入: `{ timezone?: string }`
- 输出: `{ timezone: string, datetime: string, iso: string }`
- 使用 `Intl.DateTimeFormat` 生成本地化格式，默认时区 `Asia/Shanghai`

## 添加新工具

1. 在 `backend/src/mastra/tools/builtins.ts` 中使用 `createTool()` 创建工具
2. 调用 `registerTool()` 注册到 Registry
3. 在 `backend/src/mastra/agents/registry.ts` 中为需要该工具的 Agent 添加 `toolIds`

示例:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { registerTool } from './registry.js';

const myTool = createTool({
  id: 'my-tool',
  description: '描述工具的功能',
  inputSchema: z.object({ param: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async ({ param }) => {
    return { result: param.toUpperCase() };
  },
});

registerTool({
  id: 'my-tool',
  displayName: '我的工具',
  description: '描述',
  tool: myTool,
  metadata: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
});
```

## 工具执行审计

所有工具调用会被记录到 `tool_executions` 表：

- `conversation_id`: 所属会话
- `message_id`: 触发调用的助手消息
- `tool_id`: 工具 ID
- `input`: JSONB 格式的输入参数
- `output`: JSONB 格式的输出结果
- `status`: `running` | `completed` | `failed` | `stopped`
- `error_code`: 错误码（仅持久化，不直接暴露给前端）
- `duration_ms`: 执行耗时（毫秒）

流式事件收敛：每次流结束（done、stopped、error、exception）都会调用 `convergeRunningToolExecutions()`，把该 message 下所有仍处于 `running` 的记录收敛到 `stopped` / `failed`，避免脏数据。

前端通过 SSE 的 `tool-call-start`、`tool-call-complete`、`tool-call-error` 事件实时展示工具执行状态。出于安全考虑，SSE 仅发送最小负载：

```typescript
{ toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed' }
```

`tool-call-error` 事件额外携带 `errorCode`（安全代码，例如 `tool_error`），不再把完整错误消息广播到客户端。
