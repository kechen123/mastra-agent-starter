import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import type { AgentDefinition } from '../../../types/conversation';
import type { SkillSummary } from '../../../types/conversation';
import { EmptyState } from './EmptyState';
import { SectionHeader } from './SectionHeader';
import { StatusPill } from './StatusPill';

interface AgentSkillsTabProps {
  agent: AgentDefinition;
  skills: SkillSummary[];
}

const SOURCE_TONE: Record<SkillSummary['source'], 'info' | 'marketplace' | 'success'> = {
  builtin: 'info',
  marketplace: 'marketplace',
  local: 'success',
};

const SOURCE_LABEL: Record<SkillSummary['source'], string> = {
  builtin: '内置',
  marketplace: '市场',
  local: '本地',
};

const COMPAT_TONE: Record<SkillSummary['compatibility'], 'success' | 'warning' | 'danger' | 'muted'> = {
  compatible: 'success',
  'requires-runtime': 'warning',
  unsupported: 'danger',
  unknown: 'muted',
};

const COMPAT_LABEL: Record<SkillSummary['compatibility'], string> = {
  compatible: 'compatible',
  'requires-runtime': 'requires-runtime',
  unsupported: 'unsupported',
  unknown: 'unknown',
};

/**
 * Skills Tab：列出当前 Agent 已绑定的所有 Skill，含 source / compatibility / 允许的工具。
 *
 * 表格化布局：每行 = 名称 + ID + badges + 描述 + allowedTools。
 */
export function AgentSkillsTab({ agent, skills }: AgentSkillsTabProps) {
  const resolved = useMemo(() => {
    return agent.boundSkillIds
      .map((id) => skills.find((skill) => skill.id === id))
      .filter((skill): skill is SkillSummary => Boolean(skill));
  }, [agent.boundSkillIds, skills]);

  const missing = agent.boundSkillIds.filter((id) => !skills.some((skill) => skill.id === id));

  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? resolved.filter(
        (skill) =>
          skill.id.toLowerCase().includes(trimmed) ||
          skill.name.toLowerCase().includes(trimmed) ||
          skill.description.toLowerCase().includes(trimmed),
      )
    : resolved;

  return (
    <div className="grid gap-5">
      <SectionHeader
        label="Skills"
        count={resolved.length}
        trailing={
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选已绑定技能…"
            aria-label="筛选已绑定技能"
            className="h-[26px] w-[180px] py-0.5 px-2 text-[12px] text-app-text bg-app-bg border border-app-border-strong rounded-[3px] outline-0 placeholder:text-app-muted"
          />
        }
      />

      {resolved.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="此 Agent 没有绑定任何技能"
          description="Skill 由后端 agent_skill_bindings 表维护，可通过 bind/unbind API 调整。"
        />
      ) : filtered.length === 0 ? (
        <p className="m-0 text-[12px] text-app-muted">没有匹配的技能。</p>
      ) : (
        <ul className="m-0 p-0 list-none grid">
          {filtered.map((skill) => (
            <li
              key={skill.id}
              className="grid grid-cols-[200px_1fr] gap-3 py-3 border-b border-app-divider last:border-b-0"
            >
              <div className="grid gap-1 min-w-0">
                <span className="text-[13px] font-medium text-app-text truncate">{skill.name}</span>
                <span className="app-mono text-[11.5px] text-app-muted truncate">{skill.id}</span>
                <div className="flex flex-wrap items-center gap-1 mt-0.5">
                  <StatusPill tone={SOURCE_TONE[skill.source]}>{SOURCE_LABEL[skill.source]}</StatusPill>
                  <StatusPill tone={COMPAT_TONE[skill.compatibility]} uppercase>
                    {COMPAT_LABEL[skill.compatibility]}
                  </StatusPill>
                  {skill.hasScripts && <StatusPill tone="muted">has-scripts</StatusPill>}
                </div>
              </div>
              <div className="grid gap-1.5 min-w-0">
                <p className="m-0 text-[12.5px] text-app-muted leading-[1.55]">{skill.description}</p>
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] uppercase tracking-[0.04em] text-app-muted">tools</span>
                    {skill.allowedTools.map((toolId) => (
                      <span
                        key={toolId}
                        className="app-mono inline-flex items-center px-1.5 h-[20px] text-[10.5px] text-app-text bg-app-surface-muted border border-app-divider rounded-[3px]"
                      >
                        {toolId}
                      </span>
                    ))}
                  </div>
                )}
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
                <StatusPill tone="warning">未在 Skill 注册表中找到</StatusPill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
