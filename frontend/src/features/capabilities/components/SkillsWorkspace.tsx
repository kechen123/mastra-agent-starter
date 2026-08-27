import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listSkills, listTools, type ToolDefinition } from '../../../lib/api';
import { listAgents } from '../../../lib/conversations';
import type { AgentDefinition, SkillSummary } from '../../../types/conversation';
import { AgentDetail } from './AgentDetail';
import { AgentRail } from './AgentRail';
import { MarketplaceTab } from './MarketplaceTab';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export interface SkillsWorkspaceProps {
  /** 触发"在对话中使用"按钮后回调，父组件负责切换 activeModule 与 agent 选择。 */
  onStartChat?: (agentId: string) => void;
}

/**
 * Agent Workbench（"能力" 模块）：
 *
 * 布局：左侧 Agent rail + 右侧 5 Tab（Overview / Tools / Skills / Instructions / Marketplace）。
 *
 * 数据策略：组件自己拉一次 agents + tools + skills，不持有跨 Feature 状态。
 *
 * 保留原 SkillsWorkspace 的所有市场 / 安装 / 卸载能力（MarketplaceTab），
 * 不删除任何已有功能，不造假数据。
 */
export function SkillsWorkspace({ onStartChat }: SkillsWorkspaceProps = {}) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 用户主动选择的 Agent；为 null 时回退到第一个 Agent（避免额外渲染与 setState-in-effect）。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentRailHost, setAgentRailHost] = useState<HTMLElement | null>(null);
  const effectiveSelectedId = selectedId ?? agents[0]?.id ?? null;

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [a, t, s] = await Promise.all([listAgents(), listTools(), listSkills()]);
      setAgents(a);
      setTools(t);
      setSkills(s);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首次挂载加载全部数据；refreshAll 内部用 setState 表达 loading/error 是预期模式。
    // oxlint react/set-state-in-effect 会误报，置位标记保留显式加载语义。
    // eslint-disable-next-line react/set-state-in-effect
    void refreshAll();
  }, [refreshAll]);

  // 能力页的 Agent rail 复用 App 第一列侧边栏，避免出现空的全局栏和第二个平行栏。
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 等待 sibling Sidebar 的 portal 容器挂载。
    setAgentRailHost(document.getElementById('capability-agent-rail'));
  }, []);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === effectiveSelectedId) ?? null,
    [agents, effectiveSelectedId],
  );

  // 默认聊天模型：保持与 ChatWorkspace 一致（前端不暴露模型选择，UI 仅显示）。
  const defaultChatModel = useMemo(() => {
    return 'deepseek/deepseek-v4-flash';
  }, []);

  return (
    <section
      className="flex flex-1 min-w-0 min-h-0 overflow-hidden bg-app-bg relative"
      aria-label="Agent Workbench"
    >
      {error && (
        <div
          role="alert"
          className="absolute z-20 top-3 left-1/2 -translate-x-1/2 w-[calc(100%_-_24px)] max-w-[520px] py-2.5 px-3.5 text-[13px] text-app-danger bg-app-bg border border-app-danger/30 rounded-xl flex items-center gap-2 shadow-lg"
        >
          <span className="flex-1 min-w-0 truncate">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void refreshAll();
            }}
            className="text-[13px] font-medium underline underline-offset-2 cursor-pointer"
          >
            重试
          </button>
        </div>
      )}

      {agentRailHost ? createPortal(<AgentRail
        embedded
        agents={agents}
        selectedId={effectiveSelectedId}
        loading={loading}
        onSelect={setSelectedId}
      />, agentRailHost) : <AgentRail
        agents={agents}
        selectedId={effectiveSelectedId}
        loading={loading}
        onSelect={setSelectedId}
      />}

      <AgentDetail
        agent={selectedAgent}
        tools={tools}
        skills={skills}
        defaultChatModel={defaultChatModel}
        onStartChat={onStartChat ?? (() => undefined)}
        marketplaceSlot={
          <MarketplaceTab
            installed={skills}
            onRefresh={refreshAll}
            onError={setError}
            onClearError={() => setError(null)}
          />
        }
      />
    </section>
  );
}
