import { FileText } from 'lucide-react';

/**
 * Instructions Tab：诚实说明当前 API 未暴露 instructions 字段。
 *
 * 设计动机：
 * - 后端 AgentDefinition 没有 instructions 字段（只有 factory 内部闭包使用）。
 * - 假装渲染一个代码块会让用户误以为可以编辑，造成歧义。
 * - 改为说明 + 给出后端源码位置 + 给出"重新编译后生效"的工作流提示。
 */
export function AgentInstructionsTab({ agentId }: { agentId: string }) {
  return (
    <div className="grid gap-5 max-w-[760px]">
      <header className="grid gap-1.5">
        <h3 className="m-0 text-[13px] font-semibold text-app-text">系统提示（Instructions）</h3>
        <p className="m-0 text-[12.5px] text-app-muted leading-[1.6]">
          Instructions 是 Agent 的核心提示词，定义身份、语气与行为边界。
        </p>
      </header>

      <div className="grid gap-2 py-3 px-3.5 border border-dashed border-app-border-strong rounded-md bg-app-surface">
        <div className="flex items-center gap-1.5">
          <FileText size={14} strokeWidth={2} className="text-app-muted" />
          <span className="text-[12.5px] font-medium text-app-text">当前实现</span>
        </div>
        <p className="m-0 text-[12.5px] text-app-muted leading-[1.6]">
          当前后端 <code className="app-mono px-1 py-0.5 bg-app-surface-muted rounded-[3px]">GET /agents</code>{' '}
          只暴露 <code className="app-mono px-1 py-0.5 bg-app-surface-muted rounded-[3px]">id / name / description / toolIds / capabilities / boundSkillIds</code>，
          不返回 <code className="app-mono px-1 py-0.5 bg-app-surface-muted rounded-[3px]">instructions</code>。
          因此前端无法展示完整提示词原文。
        </p>
        <p className="m-0 text-[12.5px] text-app-muted leading-[1.6]">
          源码位置：
          <code className="app-mono block mt-1 px-2 py-1.5 bg-app-surface-muted rounded-[3px] break-all">
            backend/src/agents/{agentId}/instructions.ts
          </code>
        </p>
        <p className="m-0 text-[12.5px] text-app-muted leading-[1.6]">
          修改后需重启后端进程，新指令才会生效。
        </p>
      </div>
    </div>
  );
}
