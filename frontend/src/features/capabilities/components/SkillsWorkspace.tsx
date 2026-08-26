import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  bindSkillToAgent,
  installMarketSkill,
  listPopularMarketSkills,
  listSkills,
  listTools,
  previewMarketSkill,
  removeSkill,
  searchMarketSkills,
  unbindSkillFromAgent,
  type MarketSkillInfo,
  type MarketSkillPreview,
  type SkillSummary,
  type ToolDefinition,
} from '../../../lib/api';
import { listAgents } from '../../../lib/conversations';
import type { AgentDefinition } from '../../../types/conversation';
import { cn } from '../../../lib/cn';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

/**
 * 能力（Skills / Tools / 市场 / 绑定）主面板。
 *
 * 组件内部直接调用 Skills / Tools / Agents API，但不持有跨 Feature 状态；
 * 卸载 / 绑定操作触发的副作用由调用方负责持久化与刷新。
 */
export function SkillsWorkspace() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [marketResults, setMarketResults] = useState<MarketSkillInfo[]>([]);
  const [searchingMarket, setSearchingMarket] = useState(false);
  const [selectedMarketSkill, setSelectedMarketSkill] = useState<MarketSkillInfo | null>(null);
  const [preview, setPreview] = useState<MarketSkillPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [s, a, t] = await Promise.all([listSkills(), listAgents(), listTools()]);
      setSkills(s);
      setAgents(a);
      setTools(t);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadPopular() {
    setSearchingMarket(true);
    try {
      const r = await listPopularMarketSkills();
      setMarketResults(r.results);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSearchingMarket(false);
    }
  }

  async function handleSearch(query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      void loadPopular();
      return;
    }
    setSearchingMarket(true);
    try {
      const r = await searchMarketSkills(trimmed);
      setMarketResults(r.results);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSearchingMarket(false);
    }
  }

  async function handleSelectMarketSkill(item: MarketSkillInfo) {
    setSelectedMarketSkill(item);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const p = await previewMarketSkill(item.owner, item.repo, item.skillName);
      setPreview(p);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleInstall() {
    if (!selectedMarketSkill || !preview) return;
    setInstalling(true);
    try {
      await installMarketSkill(selectedMarketSkill.owner, selectedMarketSkill.repo, selectedMarketSkill.skillName);
      setSelectedMarketSkill(null);
      setPreview(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemove(id: string) {
    if (!confirm('确定要卸载此技能吗？')) return;
    try {
      await removeSkill(id);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  async function handleBind(skillId: string, agentId: string) {
    try {
      await bindSkillToAgent(skillId, agentId);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  async function handleUnbind(skillId: string, agentId: string) {
    try {
      await unbindSkillFromAgent(skillId, agentId);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void loadPopular(); }, []);

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-y-auto py-8 px-7 bg-app-bg">
      <div className="w-full max-w-[920px] mx-auto">
        <header className="flex items-start justify-between gap-4 mb-7">
          <div>
            <h1 className="m-0 text-2xl">能力</h1>
            <p className="mt-2 text-app-muted text-sm">查看当前 Starter 已提供的 Skills 与 Tools。</p>
          </div>
        </header>
        {error && <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">{error}</p>}
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">Tools</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在加载工具…</p>
            : tools.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">当前没有可用工具。</p>
              : (
                <div className="grid gap-2.5">
                  {tools.map((tool) => (
                    <article className="flex items-start justify-between gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl" key={tool.id}>
                      <div className="min-w-0">
                        <strong className="text-[15px]">{tool.displayName}</strong>
                        <span className="inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold text-app-skill-builtin bg-app-skill-builtin/10">内置</span>
                        <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">{tool.description}</p>
                        <small className="text-app-muted text-xs">ID：{tool.id}</small>
                      </div>
                      <div className="grid gap-1 shrink-0 w-40 text-app-muted text-xs">
                        <small>可用于</small>
                        {agents.filter((agent) => agent.toolIds.includes(tool.id)).map((agent) => <span key={agent.id} className="text-app-text">{agent.name}</span>)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">从 skills.sh 安装</h2>
          <div className="flex gap-2.5 items-center flex-wrap">
            <input
              className="min-w-[180px] py-2.5 px-2.5 text-sm text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(searchQuery); }}
              placeholder="搜索 skills.sh 上的技能"
            />
            <button className="py-2.5 px-3 text-sm text-app-surface bg-app-text border border-app-text rounded-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-55" onClick={() => void handleSearch(searchQuery)} disabled={searchingMarket} type="button">搜索</button>
          </div>
          <div className="mt-3.5">
            {searchingMarket ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">搜索中…</p>
              : marketResults.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无结果，请尝试其他关键词。</p>
                : (
                  <div className="grid gap-2.5">
                    {marketResults.map((item) => (
                      <button
                        key={item.id}
                        className={cn('flex items-center gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl text-left hover:bg-app-surface-muted', selectedMarketSkill?.id === item.id && 'bg-app-surface-muted')}
                        type="button"
                        onClick={() => void handleSelectMarketSkill(item)}
                      >
                        <div className="min-w-0">
                          <strong className="text-[15px]">{item.name}</strong>
                          <small className="block text-app-muted text-xs">{item.owner}/{item.repo}/{item.skillName} · {item.installs} 安装</small>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
          </div>
          {previewLoading && <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在拉取预览…</p>}
          {preview && selectedMarketSkill && (
            <div className="mt-3.5 p-3.5 bg-app-surface-muted border border-app-border rounded-md">
              <strong className="block mb-1.5 text-[15px]">{preview.name}</strong>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">{preview.description}</p>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">文件数：{preview.files.length}{preview.hasScripts ? ' · 包含脚本，将被标记为 requires-runtime，无法绑定' : ''}</p>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">兼容性：{preview.compatibility}</p>
              <button className="mt-2 inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55" type="button" disabled={installing} onClick={() => void handleInstall()}>{installing ? '安装中…' : '安装到本地'}</button>
            </div>
          )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">已安装技能</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">加载中…</p>
            : skills.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无技能。</p>
              : (
                <div className="grid gap-2.5">
                  {skills.map((skill) => (
                    <div className="flex items-start justify-between gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl" key={skill.id}>
                      <div className="min-w-0">
                        <strong className="text-[15px]">{skill.name}</strong>
                        <span className={cn('inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold',
                          skill.source === 'builtin' && 'text-app-skill-builtin bg-app-skill-builtin/10',
                          skill.source === 'marketplace' && 'text-app-skill-marketplace bg-app-skill-marketplace/10',
                          skill.source === 'local' && 'text-app-skill-local bg-app-skill-local/10',
                        )}>{skill.source}</span>
                        <span className={cn('inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold',
                          skill.compatibility === 'compatible' && 'text-app-success bg-app-success/10',
                          skill.compatibility === 'requires-runtime' && 'text-app-warning bg-app-warning/10',
                          skill.compatibility === 'unsupported' && 'text-app-danger bg-app-danger/10',
                          skill.compatibility === 'unknown' && 'text-gray-500 bg-gray-500/10',
                        )}>{skill.compatibility}</span>
                        <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">{skill.description}</p>
                      </div>
                      <div className="shrink-0">
                        {skill.source !== 'builtin' && (
                          <button className="grid place-items-center p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={() => handleRemove(skill.id)} aria-label={`卸载 ${skill.name}`}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">Agent 技能绑定</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">加载中…</p>
            : agents.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无 Agent。</p>
              : (
                <div className="grid gap-3.5">
                  {agents.map((agent) => {
                    const boundIds = agent.boundSkillIds ?? [];
                    return (
                      <div className="p-3.5 bg-app-surface border border-app-border rounded-xl" key={agent.id}>
                        <strong className="block mb-2.5 text-[15px]">{agent.name}</strong>
                        <div className="flex flex-wrap gap-2.5">
                          {skills.filter((s) => s.compatibility === 'compatible').length === 0 ? (
                            <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无可绑定的兼容技能。</p>
                          ) : (
                            skills.filter((s) => s.compatibility === 'compatible').map((skill) => {
                              const isBound = boundIds.includes(skill.id);
                              return (
                                <label key={skill.id} className="flex items-center gap-1.5 py-1.5 px-2.5 bg-app-surface-muted border border-app-border rounded text-[13px] cursor-pointer">
                                  <input type="checkbox" className="cursor-pointer" checked={isBound} onChange={(e) => {
                                    if (e.target.checked) {
                                      void handleBind(skill.id, agent.id);
                                    } else {
                                      void handleUnbind(skill.id, agent.id);
                                    }
                                  }} />
                                  <span>{skill.name}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
        </div>
      </div>
    </section>
  );
}
