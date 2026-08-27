import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
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
          title="未选中任何 Agent"
          description="从左侧选择一个 Agent 查看其配置、工具与技能。"
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
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools', count: resolvedToolCount },
    { id: 'skills', label: 'Skills', count: resolvedSkillCount },
    { id: 'instructions', label: 'Instructions' },
    { id: 'marketplace', label: 'Marketplace', count: skills.length },
  ];

  return (
    <section className="flex-1 min-w-0 min-h-0 grid grid-rows-[auto_auto_1fr] bg-app-bg" aria-label={`Agent 详情：${agent.name}`}>
      <header className="sticky top-0 z-10 grid gap-1.5 px-6 pt-4 pb-3 border-b border-app-divider bg-app-surface">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <h2 className="m-0 text-[16px] font-semibold tracking-[-0.01em] text-app-text truncate">
                {agent.name}
              </h2>
              <span className="app-mono text-[11.5px] text-app-muted shrink-0">{agent.id}</span>
            </div>
            {agent.description && (
              <p className="m-0 text-[12.5px] text-app-muted leading-[1.55] max-w-[640px]">
                {agent.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onStartChat(agent.id)}
            className={cn(
              'inline-flex items-center gap-1.5 h-[30px] px-3 text-[12.5px] font-medium',
              'text-app-surface bg-app-text border border-app-text rounded-[3px] cursor-pointer',
              'transition-opacity hover:opacity-90',
              'focus-visible:outline-none focus-visible:opacity-90 focus-visible:border-focus-border',
            )}
            title={`在对话页使用 ${agent.name}`}
          >
            <MessageSquare size={13} strokeWidth={2.25} />
            在对话中使用
          </button>
        </div>
      </header>

      <TabBar tabs={tabs} active={tab} onChange={setUserTab} className="px-2" />

      <div
        id={`tab-panel-${tab}`}
        role="tabpanel"
        aria-label={tabs.find((t) => t.id === tab)?.label}
        className="overflow-y-auto app-scroll px-7 py-5"
      >
        <div className="max-w-[920px]">
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
