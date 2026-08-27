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
  embedded?: boolean;
}

/**
 * 左侧 Agent rail：sticky header + 搜索 + 列表。
 *
 * 设计原则：
 * - header 不抢戏，仅展示 section 名 + 计数。
 * - 搜索框始终可见（即使空列表）以传达"未来可发现更多"。
 * - 新建 Agent 后端未提供 API，按钮 disabled + title 提示原因，不造假。
 */
export function AgentRail({ agents, selectedId, loading, onSelect, embedded = false }: AgentRailProps) {
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
      className={cn(
        'flex flex-col h-full min-h-0 bg-app-sidebar',
        embedded ? 'w-full' : 'w-[228px] shrink-0 border-r border-app-border',
      )}
      aria-label="Agents"
    >
      <header className="shrink-0 px-3 pt-3 pb-3">
        <div className="flex items-center justify-between gap-2 px-1 mb-2.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <Bot size={16} strokeWidth={1.9} className="text-app-muted" />
            <span className="text-[13px] font-medium text-app-text">
              智能体
            </span>
            <span className="text-[12px] app-tnum text-app-muted">{agents.length}</span>
          </div>
          <button
            type="button"
            disabled
            title="Agent 注册通过后端代码完成，前端暂不开放创建。"
            className="grid place-items-center w-8 h-8 text-app-muted bg-transparent border-0 rounded-lg cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
        <div className="relative">
          <Search
            size={15}
            strokeWidth={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索智能体…"
            aria-label="搜索智能体"
            className={cn(
              'block w-full h-10 py-2 pl-9 pr-3 text-[13px] text-app-text bg-app-surface border-0 rounded-xl outline-none',
              'placeholder:text-app-muted',
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
                className="h-14 mx-2 mb-1 rounded-lg bg-app-surface-muted/70 animate-pulse"
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
          <div className="px-4 py-5 text-[13px] text-app-muted">
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
