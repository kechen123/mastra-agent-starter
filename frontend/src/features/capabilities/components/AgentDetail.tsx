import { useState } from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, MessageSquare } from 'lucide-react';
import type { AgentDefinition } from '../../../types/conversation';
import type { SkillSummary } from '../../../types/conversation';
import type { ToolDefinition } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { AgentInstructionsTab } from './AgentInstructionsTab';
import { AgentOverviewTab } from './AgentOverviewTab';
import { AgentSkillsTab } from './AgentSkillsTab';
import { AgentToolsTab } from './AgentToolsTab';
import { EmptyState } from './EmptyState';
import { TabBar } from './TabBar';

type TabId = 'overview' | 'tools' | 'skills' | 'instructions' | 'marketplace';

interface AgentDetailProps {
  agents: AgentDefinition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  agent: AgentDefinition | null;
  tools: ToolDefinition[];
  skills: SkillSummary[];
  defaultChatModel: string;
  onStartChat: (agentId: string) => void;
  /** Marketplace Tab 由父组件注入：保留原 SkillsWorkspace 的市场/安装/卸载能力。 */
  marketplaceSlot?: React.ReactNode;
}

/**
 * Agent 详情容器：sticky header + TabBar + Tab 内容。
 *
 * 设计原则：
 * - sticky header 永远展示身份信息（name + id + description 概要）。
 * - tab 状态本地 useState（不持久化到 URL，避免动路由）。
 * - agent 切换时：如果上一 tab 在新 Agent 下"看起来空"，渲染时回退到 overview（不强制 setState）。
 * - Marketplace Tab 是系统级操作（不受 Agent 切换影响），由父组件注入 slot。
 */
export function AgentDetail({
  agents,
  selectedId,
  onSelect,
  loading,
  agent,
  tools,
  skills,
  defaultChatModel,
  onStartChat,
  marketplaceSlot,
}: AgentDetailProps) {
  const [userTab, setUserTab] = useState<TabId>('overview');

  if (!agent) {
    return (
      <section className="flex-1 min-w-0 min-h-0 grid place-items-center bg-app-bg">
        <EmptyState
          icon={MessageSquare}
          title={loading ? '正在加载能力…' : '暂无可用能力'}
          description={loading ? '正在读取智能体、工具与技能配置。' : '后端尚未注册任何 Agent。'}
        />
      </section>
    );
  }

  // 渲染时回退：如果当前 tab 在新 Agent 下为空，回到 overview，但保留用户选择。
  const fallbackTab: TabId =
    userTab === 'tools' && agent.toolIds.length === 0
      ? 'overview'
      : userTab === 'skills' && agent.boundSkillIds.length === 0
        ? 'overview'
        : userTab;
  const tab = fallbackTab;

  const resolvedToolCount = agent.toolIds.filter((id) => tools.some((t) => t.id === id)).length;
  const resolvedSkillCount = agent.boundSkillIds.filter((id) => skills.some((s) => s.id === id)).length;

  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: 'overview', label: '概览' },
    { id: 'tools', label: '工具', count: resolvedToolCount },
    { id: 'skills', label: '技能', count: resolvedSkillCount },
    { id: 'instructions', label: '系统提示' },
    { id: 'marketplace', label: '技能市场', count: skills.length },
  ];

  return (
    <section className="flex-1 min-w-0 min-h-0 grid grid-rows-[auto_auto_1fr] bg-app-bg" aria-label={`Agent 详情：${agent.name}`}>
      <header className="sticky top-0 z-10 grid gap-3 px-6 max-[760px]:pl-14 sm:px-8 pt-7 pb-5 bg-app-bg/95 backdrop-blur-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2 min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="m-0 text-[24px] font-semibold tracking-[-0.03em] text-app-text">能力</h1>
              <Select.Root value={selectedId ?? undefined} onValueChange={(next) => onSelect(String(next ?? ''))}>
                <Select.Trigger className="inline-flex items-center gap-1.5 max-w-[260px] h-9 py-1.5 px-2.5 text-[13px] font-medium text-app-text bg-app-surface border border-app-border rounded-lg transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover data-[popup-open]:bg-app-hover" aria-label="选择智能体">
                  <Select.Value>{agent.name}</Select.Value>
                  <Select.Icon><ChevronDown size={14} className="text-app-muted" /></Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner sideOffset={6} align="start" className="z-30">
                    <Select.Popup className="grid min-w-[var(--anchor-width)] max-w-[320px] p-1.5 bg-app-surface border border-app-border rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)] outline-none">
                      {agents.map((item) => (
                        <Select.Item key={item.id} value={item.id} className="flex items-center justify-between gap-3 min-h-10 py-2 px-3 text-[13.5px] text-app-text rounded-lg cursor-pointer data-[highlighted]:bg-app-hover outline-none">
                          <Select.ItemText>{item.name}</Select.ItemText>
                          <Select.ItemIndicator><Check size={14} className="text-app-muted" /></Select.ItemIndicator>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </div>
            <span className="app-mono text-[12px] text-app-muted">{agent.id}</span>
            {agent.description && (
              <p className="m-0 text-[13.5px] text-app-muted leading-6 max-w-[680px]">
                {agent.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onStartChat(agent.id)}
            className={cn(
              'inline-flex items-center gap-2 h-9 px-3.5 text-[13px] font-medium',
              'text-app-bg bg-app-text border-0 rounded-lg cursor-pointer',
              'transition-[transform,opacity] duration-150 active:scale-[0.98] hover:opacity-90',
              'focus-visible:outline-none focus-visible:opacity-90 focus-visible:border-focus-border max-[720px]:w-full max-[720px]:justify-center',
            )}
            title={`在对话页使用 ${agent.name}`}
          >
            <MessageSquare size={13} strokeWidth={2.25} />
            在对话中使用
          </button>
        </div>
      </header>

      <TabBar tabs={tabs} active={tab} onChange={setUserTab} className="px-6 sm:px-8" />

      <div
        id={`tab-panel-${tab}`}
        role="tabpanel"
        aria-label={tabs.find((t) => t.id === tab)?.label}
        className="overflow-y-auto app-scroll px-6 sm:px-8 py-6"
      >
        <div className="w-full max-w-[860px] mx-auto">
          {tab === 'overview' && (
            <AgentOverviewTab
              agent={agent}
              defaultChatModel={defaultChatModel}
              tools={tools}
              skills={skills}
            />
          )}
          {tab === 'tools' && <AgentToolsTab agent={agent} tools={tools} />}
          {tab === 'skills' && <AgentSkillsTab agent={agent} skills={skills} />}
          {tab === 'instructions' && <AgentInstructionsTab agentId={agent.id} />}
          {tab === 'marketplace' && marketplaceSlot}
        </div>
      </div>
    </section>
  );
}
