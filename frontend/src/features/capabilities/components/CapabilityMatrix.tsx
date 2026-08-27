import { Check, Minus } from 'lucide-react';
import type { AgentCapabilities } from '../../../types/conversation';
import { StatusPill } from './StatusPill';

interface MatrixRow {
  key: keyof AgentCapabilities;
  label: string;
  hint: string;
}

const ROWS: MatrixRow[] = [
  { key: 'knowledgeBase', label: '知识库', hint: '启用后此 Agent 会基于知识库检索回答' },
  { key: 'citations', label: '引用', hint: '回答时附带原文引用与位置' },
  { key: 'tools', label: '工具', hint: '允许 Agent 调用已绑定工具' },
  { key: 'skills', label: '技能', hint: '加载已绑定 Skill 的指引与脚本' },
];

/**
 * Capability 矩阵：4 行 × 2 列（能力 + 开关状态）。
 *
 * 不用 checkbox / switch（后端未提供 patch），仅展示状态，传达"这是定义而非配置"。
 */
export function CapabilityMatrix(props: { capabilities: AgentCapabilities }) {
  const { capabilities } = props;
  return (
    <div className="grid">
      {ROWS.map((row) => {
        const enabled = capabilities[row.key];
        return (
          <div
            key={row.key as string}
            className="grid grid-cols-[1fr_auto] sm:grid-cols-[120px_1fr_auto] items-center gap-2 sm:gap-4 px-4 py-3.5 border-b border-app-divider last:border-b-0"
          >
            <span className="text-[14px] font-medium text-app-text">{row.label}</span>
            <span className="col-span-2 sm:col-span-1 text-[13px] text-app-muted leading-5">{row.hint}</span>
            <StatusPill tone={enabled ? 'success' : 'muted'} className="justify-self-end">
              {enabled ? (
                <>
                  <Check size={11} strokeWidth={2.5} />
                  启用
                </>
              ) : (
                <>
                  <Minus size={11} strokeWidth={2.5} />
                  未启用
                </>
              )}
            </StatusPill>
          </div>
        );
      })}
    </div>
  );
}
