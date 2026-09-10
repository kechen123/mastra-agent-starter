/**
 * 智能体选择器：基于 @base-ui/react Select。
 *
 * 设计要点：
 *   - 替代 AssistantChatWorkspace 里手写的 button + absolute listbox + document mousedown 关闭逻辑；
 *   - 原生具备 Escape 关闭、焦点恢复、键盘导航、点击外部关闭、移动端定位。
 *   - 视觉延续原"按钮 + ChevronDown"形态；不破坏布局。
 */
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/cn';

export interface AgentOption {
  id: string;
  name: string;
  requiresKnowledgeBase: boolean;
}

export interface AgentSelectProps {
  agents: AgentOption[];
  value: string;
  onChange: (agentId: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}

export function AgentSelect({ agents, value, onChange, ariaLabel = '选择智能体', placeholder = '选择智能体' }: AgentSelectProps) {
  const selectedAgent = agents.find((agent) => agent.id === value) ?? null;
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(String(next ?? ''))}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex items-center gap-1.5 min-w-0 h-10 px-2.5 text-[15px] font-medium text-app-text',
          'bg-transparent border-0 rounded-lg transition-colors duration-150',
          'hover:bg-app-hover focus-visible:bg-app-hover',
          'data-[popup-open]:bg-app-hover',
        )}
      >
        <Select.Value>
          {selectedAgent ? (
            <span className="truncate">{selectedAgent.name}</span>
          ) : (
            <span className="truncate text-app-muted">{placeholder}</span>
          )}
        </Select.Value>
        <Select.Icon>
          <ChevronDown size={15} className="shrink-0 pointer-events-none text-app-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} align="start" className="z-30">
          <Select.Popup
            className="grid min-w-[var(--anchor-width)] max-w-[320px] p-1.5 bg-app-surface border border-app-border rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)] outline-none"
          >
            {agents.map((agent) => (
              <Select.Item
                key={agent.id}
                value={agent.id}
                className={cn(
                  'flex items-center justify-between gap-3 min-h-10 py-2 px-3 text-[13.5px] text-app-text rounded-lg cursor-pointer',
                  'data-[highlighted]:bg-app-hover outline-none',
                  agent.id === value && 'font-medium bg-app-hover',
                )}
              >
                <Select.ItemText>{agent.name}</Select.ItemText>
                <span className="flex items-center gap-2 shrink-0">
                  {agent.requiresKnowledgeBase && <small className="text-app-muted text-[11px]">需知识库</small>}
                  <Select.ItemIndicator>
                    <Check size={14} className="text-app-muted" />
                  </Select.ItemIndicator>
                </span>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
