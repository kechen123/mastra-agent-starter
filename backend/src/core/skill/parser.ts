/**
 * SKILL.md 内容的纯函数解析器。
 *
 * 给定输入字符串即确定性输出——不依赖文件系统或 DB，因此可以在不搭脚手架
 * 的情况下做单元测试。
 */

const QUOTE_RE = /^["']|["']$/g;

function stripQuotes(s: string): string {
  return s.replace(QUOTE_RE, '');
}

function parseInlineAllowedTools(raw: string): string[] {
  let r = raw.trim();
  if (r.startsWith('[') && r.endsWith(']')) {
    r = r.slice(1, -1);
  }
  return r
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * 从 SKILL.md frontmatter 块解析 `allowed-tools`。
 *
 * 支持：
 *  - 行内数组：`allowed-tools: [calculator, get-current-time]`
 *  - 逗号列表：`allowed-tools: calculator, get-current-time`
 *  - 单值：`allowed-tools: calculator`
 *  - YAML 块列表：
 *      allowed-tools:
 *        - calculator
 *        - "get-current-time"
 *
 * 单引号 / 双引号全部容忍。空列表（`allowed-tools: []`）返回 `[]`。
 */
export function parseAllowedToolsFromFrontmatter(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const body = fmMatch[1] ?? '';

  const keyMatch = body.match(/^[ \t]*allowed-tools[ \t]*:[ \t]*(.*)$/m);
  if (!keyMatch) return [];
  const keyOffset = (keyMatch.index ?? 0) + keyMatch[0].length;

  const inlineValue = (keyMatch[1] ?? '').trim();
  if (inlineValue) {
    return parseInlineAllowedTools(inlineValue);
  }

  const after = body.slice(keyOffset);
  const tools: string[] = [];
  for (const line of after.split('\n')) {
    const m = line.match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
    if (!m) {
      if (line.trim() === '') continue;
      break;
    }
    const v = stripQuotes((m[1] ?? '').trim());
    if (v) tools.push(v);
  }
  return tools;
}

/**
 * 最小化的 frontmatter 解析器，只解析 `name` 和 `description`。当
 * frontmatter 缺失时回退到 H1 标题与首行 blockquote。
 */
export function parseSkillMdMeta(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  if (fmMatch) {
    const body = fmMatch[1] ?? '';
    const nameMatch = body.match(/^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m);
    if (nameMatch) name = stripQuotes(nameMatch[1]?.trim() ?? '');
    const descMatch = body.match(/^[ \t]*description[ \t]*:[ \t]*(.+?)[ \t]*$/m);
    if (descMatch) description = stripQuotes(descMatch[1]?.trim() ?? '');
  }
  // 回退：H1 标题或首段 blockquote
  if (!name) {
    const h1 = content.match(/^#\s+(.+)/m);
    if (h1) name = h1[1]?.trim() ?? '';
  }
  if (!description) {
    const descLine = content.match(/^>\s*(.+)/m);
    if (descLine) description = descLine[1]?.trim() ?? '';
  }
  return { name, description };
}
