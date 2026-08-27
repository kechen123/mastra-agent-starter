import { Download, ExternalLink, Loader2, PackageOpen, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../../lib/cn';
import {
  installMarketSkill,
  listPopularMarketSkills,
  previewMarketSkill,
  removeSkill,
  searchMarketSkills,
  type MarketSkillInfo,
  type MarketSkillPreview,
} from '../../../lib/api';
import type { SkillSummary } from '../../../types/conversation';
import { EmptyState } from './EmptyState';
import { SectionHeader } from './SectionHeader';
import { StatusPill } from './StatusPill';

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

interface MarketplaceTabProps {
  installed: SkillSummary[];
  onRefresh: () => Promise<void> | void;
  onError: (message: string) => void;
  onClearError: () => void;
}

/**
 * Marketplace Tab：保留原 SkillsWorkspace 的市场搜索 / 预览 / 安装 / 卸载能力。
 *
 * 设计动机：用户要求不删除已有功能。市场工作流不属于单 Agent 关系展示，
 * 因此独立成 Tab，避免污染 Overview / Tools / Skills。
 *
 * 内部状态：searchQuery / marketResults / searchingMarket / selectedMarketSkill / preview /
 * previewLoading / installing。状态本地，不污染父组件。
 */
export function MarketplaceTab({ installed, onRefresh, onError, onClearError }: MarketplaceTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [marketResults, setMarketResults] = useState<MarketSkillInfo[]>([]);
  const [searchingMarket, setSearchingMarket] = useState(false);
  const [selectedMarketSkill, setSelectedMarketSkill] = useState<MarketSkillInfo | null>(null);
  const [preview, setPreview] = useState<MarketSkillPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [installing, setInstalling] = useState(false);

  const loadPopular = useCallback(async () => {
    setSearchingMarket(true);
    try {
      const r = await listPopularMarketSkills();
      setMarketResults(r.results);
      onClearError();
    } catch (err) {
      onError(toErrorMessage(err));
    } finally {
      setSearchingMarket(false);
    }
  }, [onError, onClearError]);

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
      onClearError();
    } catch (err) {
      onError(toErrorMessage(err));
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
      onClearError();
    } catch (err) {
      onError(toErrorMessage(err));
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
      await onRefresh();
    } catch (err) {
      onError(toErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemove(id: string) {
    if (!window.confirm('确定要卸载此技能吗？')) return;
    try {
      await removeSkill(id);
      await onRefresh();
    } catch (err) {
      onError(toErrorMessage(err));
    }
  }

  useEffect(() => {
    // 首次挂载加载热门技能；loadPopular 内部用 setState 表达 loading/error 是预期模式。
    // eslint-disable-next-line react/set-state-in-effect
    void loadPopular();
  }, [loadPopular]);

  return (
    <div className="grid gap-8 max-w-[860px]">
      <section>
        <SectionHeader
          label="从 skills.sh 安装"
          trailing={
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search
                  size={15}
                  strokeWidth={2}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSearch(searchQuery);
                  }}
                  placeholder="搜索 skills.sh…"
                  aria-label="搜索 skills.sh 上的技能"
                  className="h-9 w-[220px] pl-9 pr-3 text-[13px] text-app-text bg-app-surface border-0 rounded-lg outline-none placeholder:text-app-muted"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSearch(searchQuery)}
                disabled={searchingMarket}
                className="h-9 px-3.5 text-[13px] font-medium text-app-bg bg-app-text border-0 rounded-lg cursor-pointer transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
              >
                搜索
              </button>
            </div>
          }
        />

        <div className="mt-3">
          {searchingMarket ? (
            <p className="m-0 py-10 text-[13px] text-app-muted text-center bg-app-surface-muted rounded-xl">
              搜索中…
            </p>
          ) : marketResults.length === 0 ? (
            <p className="m-0 py-10 text-[13px] text-app-muted text-center bg-app-surface-muted rounded-xl">
              暂无结果，请尝试其他关键词。
            </p>
          ) : (
            <ul className="m-0 p-0 list-none grid">
              {marketResults.map((item) => (
                <li key={item.id} className="border-b border-app-divider last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void handleSelectMarketSkill(item)}
                    className={cn(
                      'w-full text-left grid grid-cols-[1fr_auto] items-center gap-3 py-3.5 px-3 rounded-xl cursor-pointer transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:bg-app-row-hover',
                      selectedMarketSkill?.id === item.id
                        ? 'bg-app-hover'
                        : 'hover:bg-app-row-hover',
                    )}
                  >
                    <div className="grid gap-1 min-w-0">
                      <span className="text-[14px] font-medium text-app-text truncate">{item.name}</span>
                      <span className="app-mono text-[12px] text-app-muted truncate">
                        {item.owner}/{item.repo}/{item.skillName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusPill tone="muted">{item.installs} 安装</StatusPill>
                      <StatusPill tone={COMPAT_TONE[item.compatibility]} uppercase>
                        {COMPAT_LABEL[item.compatibility]}
                      </StatusPill>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {previewLoading && (
          <p className="m-0 mt-3 py-4 text-[13px] text-app-muted text-center bg-app-surface-muted rounded-xl flex items-center justify-center gap-2">
            <Loader2 size={12} className="animate-spin" />
            正在拉取预览…
          </p>
        )}

        {preview && selectedMarketSkill && (
          <div className="mt-4 grid gap-3 p-4 rounded-xl bg-app-surface">
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1 min-w-0">
                <strong className="text-[15px] font-semibold text-app-text">{preview.name}</strong>
                <span className="app-mono text-[12px] text-app-muted truncate">
                  {preview.owner}/{preview.repo}/{preview.skillName}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleInstall()}
                disabled={installing}
                className="inline-flex items-center gap-2 h-9 px-3.5 text-[13px] font-medium text-app-bg bg-app-text border-0 rounded-lg cursor-pointer transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
              >
                <Download size={13} strokeWidth={2.25} />
                {installing ? '安装中…' : '安装到本地'}
              </button>
            </div>
            <p className="m-0 text-[13.5px] text-app-muted leading-6">{preview.description}</p>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-app-muted">
              <span>文件 {preview.files.length}</span>
              <span>·</span>
              <span>兼容性 {COMPAT_LABEL[preview.compatibility]}</span>
              {preview.hasScripts && (
                <StatusPill tone="warning">包含脚本，requires-runtime，无法绑定</StatusPill>
              )}
            </div>
            {preview.skillMd && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[13px] text-app-muted hover:text-app-text inline-flex items-center gap-1.5">
                  <ExternalLink size={11} strokeWidth={2} />
                  查看 SKILL.md
                </summary>
                <pre className="app-mono mt-2 p-3.5 max-h-[300px] overflow-auto text-[12px] leading-5 text-app-text bg-app-surface-muted rounded-xl whitespace-pre-wrap break-words">
                  {preview.skillMd}
                </pre>
              </details>
            )}
          </div>
        )}
      </section>

      <section>
        <SectionHeader label="已安装技能" count={installed.length} />
        {installed.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={PackageOpen}
              title="还没有安装的 Skill"
              description="通过上方市场搜索安装，或在后端放置本地 Skill。"
            />
          </div>
        ) : (
          <ul className="m-0 p-0 list-none grid mt-3">
            {installed.map((skill) => (
              <li
                key={skill.id}
                className="grid grid-cols-[1fr_auto] items-start gap-4 py-4 border-b border-app-divider last:border-b-0"
              >
                <div className="grid gap-1 min-w-0">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[14px] font-medium text-app-text truncate">{skill.name}</span>
                    <span className="app-mono text-[12px] text-app-muted truncate">{skill.id}</span>
                  </div>
                  <p className="m-0 text-[13.5px] text-app-muted leading-6">{skill.description}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill tone={SOURCE_TONE[skill.source]}>{SOURCE_LABEL[skill.source]}</StatusPill>
                    <StatusPill tone={COMPAT_TONE[skill.compatibility]} uppercase>
                      {COMPAT_LABEL[skill.compatibility]}
                    </StatusPill>
                    {skill.hasScripts && <StatusPill tone="muted">has-scripts</StatusPill>}
                  </div>
                </div>
                {skill.source !== 'builtin' && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(skill.id)}
                    aria-label={`卸载 ${skill.name}`}
                    className="grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg cursor-pointer hover:text-app-danger hover:bg-app-danger/10 focus-visible:text-app-danger focus-visible:bg-app-danger/10"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
