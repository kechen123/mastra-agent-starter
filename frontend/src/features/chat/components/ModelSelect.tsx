/**
 * Composer 模型入口：基于 @base-ui/react Select。
 *
 * 设计要点：
 *   - 当前只有一个可用模型（props.defaultChatModel），后端不允许切换；
 *     选项只是 props 的回显，不写后端、不伪造切换状态；
 *   - props.onChange 留作未来服务端白名单提供多个模型时挂接的扩展点，
 *     当前默认模型下不会触发调用；
 *   - 视觉与 AgentSelect / KnowledgeBasePicker 一致（圆角胶囊 + ChevronDown）；
 *   - 不得硬编码未来模型名；不得提供任意模型输入框。
 */
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { cn } from '../../../lib/cn';

export interface ModelOption {
  /** 稳定 id（与 capabilities.defaultChatModel 字符串一致）。 */
  id: string;
  /** 触发器 / 列表项显示文案。 */
  label: string;
}

export interface ModelSelectProps {
  defaultChatModel: string;
  /** 后端 llm.displayName（如 "DeepSeek"）；缺省回退 defaultChatModel。 */
  llmDisplayName?: string;
  /** 仅扩展点：当前默认模型下不会调用。 */
  onChange?: (modelId: string) => void;
  ariaLabel?: string;
}

function buildOptions(defaultChatModel: string, llmDisplayName: string | undefined): ModelOption[] {
  return [{ id: defaultChatModel, label: llmDisplayName ?? defaultChatModel }];
}

export function ModelSelect({ defaultChatModel, llmDisplayName, onChange, ariaLabel = '选择模型' }: ModelSelectProps) {
  const options = buildOptions(defaultChatModel, llmDisplayName);
  return (
    <Select.Root value={defaultChatModel} onValueChange={(next) => { onChange?.(String(next ?? defaultChatModel)); }}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1.5 min-h-9 py-1.5 px-3 text-[13px] text-app-muted bg-transparent border-0 rounded-full',
          'transition-colors duration-150 hover:text-app-text hover:bg-app-hover',
          'focus-visible:bg-app-hover data-[popup-open]:bg-app-hover data-[popup-open]:text-app-text',
        )}
      >
        <Cpu size={13} aria-hidden />
        <Select.Value>{options[0]?.label}</Select.Value>
        <Select.Icon>
          <ChevronDown size={13} className="shrink-0 pointer-events-none text-app-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} align="start" className="z-30">
          <Select.Popup className="grid min-w-[var(--anchor-width)] max-w-[280px] p-1.5 bg-app-surface border border-app-border rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)] outline-none">
            {options.map((option) => (
              <Select.Item
                key={option.id}
                value={option.id}
                className="flex items-center justify-between gap-3 min-h-10 py-2 px-3 text-[13.5px] text-app-text rounded-lg cursor-pointer data-[highlighted]:bg-app-hover outline-none"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={14} className="text-app-muted" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}