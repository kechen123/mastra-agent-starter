import { createTool } from '@mastra/core/tools';

/**
 * ToolDefinition：注册表中的最小可用单元。
 *
 * 字段说明：
 * - id：Tool 在 Agent / Skill 中引用的唯一 ID。
 * - displayName / description：用于前端 Capability UI。
 * - tool：Mastra createTool 返回的执行单元。
 * - metadata：
 *   - readOnly：仅读，不修改任何状态。
 *   - destructive：可能删除/破坏用户可见状态。
 *   - idempotent：相同输入重复调用结果一致。
 *   - openWorld：会触达网络/文件系统等外部世界。
 *   - requiresRuntime：依赖外部运行时（如 Python、Shell）。
 */
export interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  tool: ReturnType<typeof createTool>;
  metadata: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
    requiresRuntime?: boolean;
  };
}

const toolMap = new Map<string, ToolDefinition>();

/**
 * 唯一的注册入口。允许调用方只有 `backend/src/tools/index.ts`，
 * 具体 ToolDefinition 在 `tools/<id>/tool.ts` 中导出，再由 index 聚合。
 *
 * 重复注册同一 id 会抛错，便于在启动期发现冲突。
 */
export function registerTool(definition: ToolDefinition): void {
  if (toolMap.has(definition.id)) {
    throw new Error(`Tool ${definition.id} already registered`);
  }
  toolMap.set(definition.id, definition);
}

export function getToolDefinition(id: string): ToolDefinition | undefined {
  return toolMap.get(id);
}

export function listToolDefinitions(): ToolDefinition[] {
  return Array.from(toolMap.values()).map((d) => ({ ...d, tool: d.tool }));
}

/**
 * 把一组 tool id 解析为 Mastra `tools` Map。
 * 不存在或未注册的 id 直接跳过（不抛错），调用方负责传入可信 ID。
 */
export function resolveTools(ids: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const id of ids) {
    const def = toolMap.get(id);
    if (def) {
      result[id] = def.tool;
    }
  }
  return result;
}

/**
 * 取 Agent 实际可用的 tool id 列表。
 *
 * - 若未提供 allowedTools，则返回所有"Agent 声明 & 已注册"的 id（宽松模式）。
 * - 若提供 allowedTools，则取交集：必须在 Agent 声明列表、且在 Skill/调用方
 *   显式放行的集合里。这是 Skill 与 Agent 之间的"权限边界"，用来防止
 *   Skill 越权调用 Agent 未声明的工具。
 */
export function resolveToolIds(agentToolIds: string[] | undefined, allowedTools: string[] | undefined): string[] {
  if (!agentToolIds || agentToolIds.length === 0) {
    return [];
  }
  if (!allowedTools || allowedTools.length === 0) {
    return agentToolIds.filter((id) => toolMap.has(id));
  }
  const allowedSet = new Set(allowedTools);
  return agentToolIds.filter((id) => toolMap.has(id) && allowedSet.has(id));
}