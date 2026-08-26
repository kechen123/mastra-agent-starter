import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tool/registry.js';

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

export const getCurrentTimeDefinition: ToolDefinition = {
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
};