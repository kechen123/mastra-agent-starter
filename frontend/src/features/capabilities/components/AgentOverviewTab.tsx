import { Box, Layers, MessageSquare, Wrench } from 'lucide-react';
import type { AgentDefinition, SkillSummary } from '../../../types/conversation';
import type { ToolDefinition } from '../../../lib/api';
import { CapabilityMatrix } from './CapabilityMatrix';
import { SectionHeader } from './SectionHeader';
import { StatusPill } from './StatusPill';

interface AgentOverviewTabProps {
  agent: AgentDefinition;
  defaultChatModel: string;
  tools: ToolDefinition[];
  skills: SkillSummary[];
}

/**
 * Agent 总览 Tab：核心元信息 + capabilities 矩阵 + 关键计数。
 *
 * 数据策略：
 * - 模型字段后端未暴露到 /agents，从 Capabilities.defaultChatModel 取，不造假。
 * - 不重复 ChatWorkspace 里的"选择 Agent"操作。
 */
export function AgentOverviewTab({ agent, defaultChatModel, tools, skills }: AgentOverviewTabProps) {
  const resolvedTools = tools.filter((tool) => agent.toolIds.includes(tool.id));
  const resolvedSkills = skills.filter((skill) => agent.boundSkillIds.includes(skill.id));

  return (
    <div className="grid gap-7">
      <section>
        <SectionHeader label="Meta" />
        <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 mt-3 text-[12.5px]">
          <dt className="text-app-muted">名称</dt>
          <dd className="m-0 text-app-text">{agent.name}</dd>
          <dt className="text-app-muted">ID</dt>
          <dd className="m-0 app-mono text-app-text break-all">{agent.id}</dd>
          <dt className="text-app-muted">模型</dt>
          <dd className="m-0">
            <span className="app-mono text-app-text">{defaultChatModel}</span>
            <span className="ml-2 text-[11.5px] text-app-muted">默认聊天模型</span>
          </dd>
          <dt className="text-app-muted">描述</dt>
          <dd className="m-0 text-app-text leading-[1.6]">
            {agent.description ?? <span className="text-app-muted">（无描述）</span>}
          </dd>
        </dl>
      </section>

      <section>
        <SectionHeader label="Capabilities" />
        <div className="mt-3 border border-app-divider rounded-md">
          <CapabilityMatrix capabilities={agent.capabilities} />
        </div>
      </section>

      <section>
        <SectionHeader label="Stats" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mt-3">
          <StatTile icon={Wrench} label="已绑定工具" value={resolvedTools.length} tone="info" />
          <StatTile icon={Layers} label="已绑定技能" value={resolvedSkills.length} tone="success" />
          <StatTile
            icon={MessageSquare}
            label="可引用"
            value={agent.capabilities.citations ? '是' : '否'}
            tone={agent.capabilities.citations ? 'success' : 'muted'}
          />
          <StatTile
            icon={Box}
            label="知识库"
            value={agent.capabilities.knowledgeBase ? '需要' : '不需要'}
            tone={agent.capabilities.knowledgeBase ? 'warning' : 'muted'}
          />
        </div>
      </section>
    </div>
  );
}

function StatTile(props: {
  icon: typeof Wrench;
  label: string;
  value: number | string;
  tone: 'info' | 'success' | 'warning' | 'muted';
}) {
  const { icon: Icon, label, value, tone } = props;
  return (
    <div className="grid grid-cols-[24px_1fr_auto] items-center gap-2 px-3 py-2.5 border border-app-divider rounded-md bg-app-surface">
      <Icon size={14} strokeWidth={2} className="text-app-muted" aria-hidden="true" />
      <span className="text-[11.5px] text-app-muted uppercase tracking-[0.04em]">{label}</span>
      <StatusPill tone={tone} className="justify-self-end">
        {value}
      </StatusPill>
    </div>
  );
}
