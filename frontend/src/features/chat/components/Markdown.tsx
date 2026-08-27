import type { ReactNode } from 'react';

/**
 * 最小 Markdown 渲染器（无依赖、零运行时代价）。
 *
 * 支持：
 * - **bold** / *italic* / `inline code`
 * - [text](url)
 * - # / ## / ### / #### 标题（映射到 h3 / h4 / h5 / h6）
 * - - * 无序列表（多行连续以 - 或 * 开头）
 * - 1. 2. 有序列表
 * - > 引用块
 * - ``` 代码块（首行可选语言标记）
 * - 段落内的硬换行（\n）
 *
 * 不支持：嵌套列表、表格、HTML 注入（所有内容当作文本渲染）。
 *
 * 安全：所有内容 escape 为文本节点，不解析 HTML。
 */

const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*)|(?<!\*)\*[^*\n]+\*(?!\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx));
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      parts.push(
        <strong key={`${keyPrefix}-b-${key++}`} className="font-semibold">
          {raw.slice(2, -2)}
        </strong>,
      );
    } else if (raw.startsWith('`')) {
      parts.push(
        <code
          key={`${keyPrefix}-c-${key++}`}
          className="px-1.5 py-0.5 mx-0.5 text-[12.5px] font-mono bg-app-surface-muted border border-app-divider rounded-[3px] break-words"
        >
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(raw);
      if (linkMatch) {
        parts.push(
          <a
            key={`${keyPrefix}-l-${key++}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-app-info underline underline-offset-2 hover:opacity-80 break-words"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(raw);
      }
    } else {
      // italic
      parts.push(
        <em key={`${keyPrefix}-i-${key++}`} className="italic">
          {raw.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = idx + raw.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function isUnorderedList(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line));
}

function isOrderedList(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line));
}

function isBlockquote(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^>\s?/.test(line));
}

function renderBlock(block: string, keyPrefix: string): ReactNode {
  const trimmed = block.trim();
  if (trimmed.length === 0) return null;

  // Fenced code block ``` ... ```
  if (trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length >= 6) {
    const inner = trimmed.slice(3, -3);
    const firstNewline = inner.indexOf('\n');
    const code = firstNewline > 0 && /^[a-zA-Z][a-zA-Z0-9+-]*$/.test(inner.slice(0, firstNewline).trim())
      ? inner.slice(firstNewline + 1)
      : inner;
    return (
      <pre
        key={keyPrefix}
        className="my-3 px-3 py-2.5 overflow-x-auto app-scroll bg-app-surface-muted border border-app-border rounded-md"
      >
        <code className="block whitespace-pre font-mono text-[12.5px] leading-[1.55] text-app-text">
          {code}
        </code>
      </pre>
    );
  }

  const lines = trimmed.split('\n');

  // Heading: 1-4 个 # 开头
  const headingMatch = /^(#{1,4})\s+(.+)$/.exec(lines[0]!);
  if (headingMatch && lines.length === 1) {
    const hashes = headingMatch[1]!.length;
    const level = Math.min(hashes + 2, 6);
    const text = headingMatch[2]!;
    const sizeClass = level <= 3 ? 'text-[15px]' : level === 4 ? 'text-[14px]' : 'text-[13.5px]';
    const Tag = (`h${level}` as 'h3' | 'h4' | 'h5' | 'h6');
    return (
      <Tag key={keyPrefix} className={`m-0 mt-4 mb-2 first:mt-0 font-semibold text-app-text ${sizeClass}`}>
        {renderInline(text, keyPrefix)}
      </Tag>
    );
  }

  // List block: must consume all lines
  if (isUnorderedList(lines)) {
    return (
      <ul
        key={keyPrefix}
        className="my-3 pl-5 list-disc space-y-1 marker:text-app-muted"
      >
        {lines.map((line, i) => (
          <li key={i} className="leading-[1.65]">
            {renderInline(line.replace(/^[-*]\s+/, ''), `${keyPrefix}-${i}`)}
          </li>
        ))}
      </ul>
    );
  }
  if (isOrderedList(lines)) {
    return (
      <ol
        key={keyPrefix}
        className="my-3 pl-5 list-decimal space-y-1 marker:text-app-muted"
      >
        {lines.map((line, i) => (
          <li key={i} className="leading-[1.65]">
            {renderInline(line.replace(/^\d+\.\s+/, ''), `${keyPrefix}-${i}`)}
          </li>
        ))}
      </ol>
    );
  }

  if (isBlockquote(lines)) {
    const content = lines.map((line) => line.replace(/^>\s?/, '')).join(' ');
    return (
      <blockquote
        key={keyPrefix}
        className="my-3 pl-3 border-l-2 border-app-border-strong text-app-muted leading-[1.65]"
      >
        {renderInline(content, keyPrefix)}
      </blockquote>
    );
  }

  // Default: paragraph with soft line breaks
  return (
    <p
      key={keyPrefix}
      className="m-0 mb-3 last:mb-0 leading-[1.65] text-app-text"
    >
      {lines.map((line, i) => (
        <span key={i}>
          {renderInline(line, `${keyPrefix}-l${i}`)}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

/**
 * Markdown 组件：渲染用户提供的 Markdown 文本。
 *
 * 使用场景：Assistant 消息正文（保留纯文字流交互语言，仅排版升级）。
 */
export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => (
        <span key={`md-${i}`} className="block">
          {renderBlock(block, `md-${i}`)}
        </span>
      ))}
    </>
  );
}
