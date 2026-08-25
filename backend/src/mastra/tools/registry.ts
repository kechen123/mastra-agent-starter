import { createTool } from '@mastra/core/tools';

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

export function resolveTools(ids: string[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const id of ids) {
    const def = toolMap.get(id);
    if (def) {
      result[id] = def.tool;
    }
  }
  return result;
}

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
