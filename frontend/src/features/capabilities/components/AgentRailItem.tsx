import { Library, Wrench } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { AgentDefinition } from '../../../types/conversation';

/**
 * 单个 Agent 列表项。
 *
 * 展示：name + id（mono）+ tool/skill 计数徽章。
 *
 * 设计原则：
 * - 紧凑（高度 ~46px），整行可点击，选中态用左侧 2px indicator + 表面色变化。
 * - 计数徽章是 icon + 数字（无填充），不抢色块视觉。
 * - hover / active / focus-visible 都用 CSS token。
 */
export function AgentRailItem(props: {
  agent: AgentDefinition;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { agent, selected, onSelect } = props;
  const toolCount = agent.toolIds.length;
  const skillCount = agent.boundSkillIds.length;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(agent.id)}
      className={cn(
        'group relative flex flex-col gap-1.5 w-auto mx-2 mb-1 py-2.5 px-3 text-left cursor-pointer rounded-lg',
        'border-0 bg-transparent',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:bg-app-row-hover',
        selected ? 'bg-app-hover' : 'hover:bg-app-row-hover',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-2 bottom-2 w-[2px] rounded-full transition-opacity',
          selected ? 'bg-app-text opacity-100' : 'opacity-0',
        )}
      />
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="truncate text-[14px] font-medium text-app-text">{agent.name}</span>
        {agent.capabilities.knowledgeBase && (
          <span
            title="需要绑定知识库"
            aria-label="需要绑定知识库"
            className="inline-grid place-items-center w-[14px] h-[14px] text-app-muted"
          >
            <Library size={11} strokeWidth={2} />
          </span>
        )}
      </span>
      <span className="flex items-center gap-2.5 text-[12px] text-app-muted app-tnum">
        <span className="app-mono truncate">{agent.id}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1">
            <Wrench size={11} strokeWidth={2} />
            {toolCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6Z" />
            </svg>
            {skillCount}
          </span>
        </span>
      </span>
    </button>
  );
}
