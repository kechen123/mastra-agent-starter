# Tool 系统文档

## Tool Registry

位于 `backend/src/core/tool/registry.ts`：

- `registerTool(definition: ToolDefinition)`: 注册工具，重复 ID 会抛出异常（**唯一对外入口**，由 `tools/index.ts` 调用）
- `getToolDefinition(id)`: 获取工具定义
- `listToolDefinitions()`: 列出所有已注册工具
- `resolveTools(ids)`: 根据 ID 列表返回工具实例映射（用于注入 Agent）
- `resolveToolIds(agentToolIds, allowedTools)`: 在 agent 配置和允许列表之间取交集

具体工具定义放在 `backend/src/tools/<id>/tool.ts`，由 `backend/src/tools/index.ts` 统一 `registerTool()`。

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

## Tool Metadata 的真实定位（必读）

`ToolDefinition.metadata` 当前是 **能力声明 + UI 展示信息**，**不是生产级授权系统**。它用于：

- 前端 Capability UI 用 flags 告诉用户"这个工具是只读还是可能破坏状态"；
- 让 Runtime / 路由在调试时区分"是否会触达外部世界"；
- 作为未来生产化阶段的输入清单（见下文）。

它 **不** 会：

- 自动拒绝任何 Tool 调用——所有 metadata 字段都是声明，不是拦截；
- 自动校验调用者身份 / 资源归属；
- 自动脱敏输入输出、自动审计 secret、自动审批破坏性操作。

### 编写自定义 Tool 的硬约束

- **不要** 让 Tool 返回密码、Token、Cookie、Authorization Header 或任何 secret。即使 Tool 内部需要使用密钥，也只能写日志或在受控字段中调用，绝不能放进 SSE 推送、`output` 字段、错误消息或前端任何位置。
- `destructive: true` 与 `openWorld: true` 的 Tool 在引入生产业务前 **必须** 先接入：
  - 身份认证（谁能调用此 Tool）；
  - 租户 / 资源归属校验（这个 Tool 是否可以动这条资源）；
  - 用户确认或策略审批（是否允许这次破坏性 / 跨边界调用）；
  - 输入输出脱敏与审计（把敏感字段记到 `tool_executions` 但绝不向前端泄漏）。
- 本阶段只写清边界，**不** 实现未经确认的审批流或登录系统。在没有身份提供方之前，**禁止** 把 `requiresAuth: false` 批量替换为 `true`——那会造成伪安全或系统不可用。

### 现有 Tool 的 metadata 标注

| Tool | readOnly | destructive | idempotent | openWorld | requiresRuntime |
|------|----------|-------------|------------|-----------|-----------------|
| `calculator` | true | false | true | false | false |
| `get-current-time` | true | false | false | false | false |

两个内置 Tool 都明确 `destructive=false` 且 `openWorld=false`，与当前 Starter 的"匿名、单租户、纯本地/受信网络"边界一致。任何新增 Tool 在登记到 `tools/index.ts` 之前都需要重新评估这五个字段。

## 内置工具

### calculator

**ID**: `calculator`
**位置**: `backend/src/tools/calculator/tool.ts`

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
**位置**: `backend/src/tools/get-current-time/tool.ts`

获取当前日期时间。

- 输入: `{ timezone?: string }`
- 输出: `{ timezone: string, datetime: string, iso: string }`
- 使用 `Intl.DateTimeFormat` 生成本地化格式，默认时区 `Asia/Shanghai`

## 添加新工具

完整步骤见 `docs/extending.md` § 添加新 Tool。简要：

1. 在 `backend/src/tools/<your-id>/` 下新建目录
2. 复制 `backend/src/tools/_template/` 作为起点，编写 `tool.ts`
3. 在 `backend/src/tools/index.ts` 追加 `registerTool(yourDef)`
4. 在要让该 Tool 可用的 Agent 的 `AgentDefinition.toolIds` 加入新 Tool id
5. 重启后端，新 Tool 会出现在 `GET /tools`

## 工具执行审计

所有工具调用会被记录到 `tool_executions` 表（`backend/src/modules/conversations/tool-executions.ts`）：

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