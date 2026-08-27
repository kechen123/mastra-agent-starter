import { useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import type { AgentDefinition } from '../../../types/conversation';
import type { ToolDefinition } from '../../../lib/api';
import { EmptyState } from './EmptyState';
import { SectionHeader } from './SectionHeader';
import { StatusPill } from './StatusPill';

interface AgentToolsTabProps {
  agent: AgentDefinition;
  tools: ToolDefinition[];
}

const METADATA_LABEL: Record<keyof ToolDefinition['metadata'], string> = {
  readOnly: 'read-only',
  destructive: 'destructive',
  idempotent: 'idempotent',
  openWorld: 'open-world',
  requiresRuntime: 'requires-runtime',
};

const METADATA_TONE: Record<keyof ToolDefinition['metadata'], 'success' | 'danger' | 'info' | 'warning' | 'muted'> = {
  readOnly: 'success',
  destructive: 'danger',
  idempotent: 'info',
  openWorld: 'warning',
  requiresRuntime: 'muted',
};

/**
 * Tools Tab：列出当前 Agent 已绑定的所有工具，含元数据 flag 与描述。
 *
 * 表格化布局（不用卡片宫格）：每行 = ID + displayName + 元数据 flag + 描述。
 *
 * 排序：displayName 升序。
 */
export function AgentToolsTab({ agent, tools }: AgentToolsTabProps) {
  const resolved = useMemo(() => {
    return agent.toolIds
      .map((id) => tools.find((tool) => tool.id === id))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
  }, [agent.toolIds, tools]);

  const missing = agent.toolIds.filter((id) => !tools.some((tool) => tool.id === id));

  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? resolved.filter(
        (tool) =>
          tool.id.toLowerCase().includes(trimmed) ||
          tool.displayName.toLowerCase().includes(trimmed) ||
          tool.description.toLowerCase().includes(trimmed),
      )
    : resolved;

  return (
    <div className="grid gap-5">
      <SectionHeader
        label="已绑定工具"
        count={resolved.length}
        trailing={
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选已绑定工具…"
            aria-label="筛选已绑定工具"
            className="h-9 w-[220px] px-3 text-[13px] text-app-text bg-app-surface border-0 rounded-lg outline-none placeholder:text-app-muted"
          />
        }
      />

      {resolved.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="此 Agent 没有绑定任何工具"
          description="Tool 由后端 AgentDefinition.toolIds 配置，前端无法新增。"
        />
      ) : filtered.length === 0 ? (
        <p className="m-0 text-[13px] text-app-muted">没有匹配的工具。</p>
      ) : (
        <ul className="m-0 p-0 list-none grid">
          {filtered.map((tool) => (
            <li
              key={tool.id}
              className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] items-start gap-3 md:gap-4 py-4 border-b border-app-divider last:border-b-0"
            >
              <div className="grid gap-0.5 min-w-0">
                <span className="text-[14px] font-medium text-app-text truncate">{tool.displayName}</span>
                <span className="app-mono text-[12px] text-app-muted truncate">{tool.id}</span>
              </div>
              <p className="m-0 text-[13.5px] text-app-muted leading-6">{tool.description}</p>
              <div className="flex flex-wrap items-center gap-1 md:justify-end md:max-w-[260px]">
                {(Object.keys(tool.metadata) as Array<keyof ToolDefinition['metadata']>)
                  .filter((key) => tool.metadata[key])
                  .map((key) => (
                    <StatusPill key={key} tone={METADATA_TONE[key]} uppercase>
                      {METADATA_LABEL[key]}
                    </StatusPill>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <div className="grid gap-2 mt-2">
          <SectionHeader label="未解析" count={missing.length} />
          <ul className="m-0 p-0 list-none grid">
            {missing.map((id) => (
              <li
                key={id}
                className="flex items-center gap-2 py-2 border-b border-app-divider last:border-b-0"
              >
                <span className="app-mono text-[12px] text-app-muted">{id}</span>
                <StatusPill tone="warning">未在 Tool 注册表中找到</StatusPill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
