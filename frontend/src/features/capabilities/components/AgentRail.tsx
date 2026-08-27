import { Bot, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../../lib/cn';
import type { AgentDefinition } from '../../../types/conversation';
import { AgentRailItem } from './AgentRailItem';
import { EmptyState } from './EmptyState';

interface AgentRailProps {
  agents: AgentDefinition[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}

/**
 * 左侧 Agent rail：sticky header + 搜索 + 列表。
 *
 * 设计原则：
 * - header 不抢戏，仅展示 section 名 + 计数。
 * - 搜索框始终可见（即使空列表）以传达"未来可发现更多"。
 * - 新建 Agent 后端未提供 API，按钮 disabled + title 提示原因，不造假。
 */
export function AgentRail({ agents, selectedId, loading, onSelect }: AgentRailProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((agent) => {
      return (
        agent.id.toLowerCase().includes(q) ||
        agent.name.toLowerCase().includes(q) ||
        (agent.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [agents, query]);

  return (
    <aside
      className="flex flex-col w-[260px] shrink-0 h-full min-h-0 border-r border-app-border bg-app-surface"
      aria-label="Agents"
    >
      <header className="shrink-0 px-3 pt-3.5 pb-2.5 border-b border-app-divider">
        <div className="flex items-center justify-between gap-2 px-0.5 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Bot size={14} strokeWidth={2} className="text-app-muted" />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-app-muted">
              Agents
            </span>
            <span className="text-[11px] app-tnum text-app-muted">{agents.length}</span>
          </div>
          <button
            type="button"
            disabled
            title="Agent 注册通过后端代码完成，前端暂不开放创建。"
            className="grid place-items-center w-[24px] h-[24px] text-app-muted bg-transparent border border-app-border rounded-[3px] cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:border-focus-border"
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
        <div className="relative">
          <Search
            size={12}
            strokeWidth={2}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-app-muted pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Agent…"
            aria-label="搜索 Agent"
            className={cn(
              'block w-full h-[28px] py-1 pl-7 pr-2 text-[12px] text-app-text bg-app-bg border border-app-border-strong rounded-[3px] outline-0',
              'placeholder:text-app-muted app-tnum',
            )}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto app-scroll" role="listbox" aria-label="Agent 列表">
        {loading ? (
          <div className="grid gap-0">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[46px] border-b border-app-divider bg-app-surface-muted/50 animate-pulse"
                aria-hidden="true"
              />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="px-3 py-4">
            <EmptyState
              icon={Bot}
              title="暂无 Agent"
              description="后端尚未注册任何 Agent。注册方式见 backend/src/agents/index.ts。"
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-app-muted">
            <p className="m-0">没有匹配的 Agent。</p>
          </div>
        ) : (
          filtered.map((agent) => (
            <AgentRailItem
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}
