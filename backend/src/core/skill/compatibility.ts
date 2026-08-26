/**
 * Skill 兼容性分类。
 *
 * 纯函数：输入文件清单 + allowed-tools，输出判定结果。不访问文件系统
 * 或 DB，由调用方（registry / discovery）提供文件清单——便于直接做单测。
 */
import { listToolDefinitions } from '../tool/registry.js';
import { getAgentDefinition } from '../agent/registry.js';

const SCRIPT_EXT_PATTERN = /\.(sh|bash|zsh|ps1|bat|cmd|py|js|ts|mjs|cjs|rb|pl)$/i;
const SEP_RE = /[\\/]/g;

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

function isExecutableFileName(name: string): boolean {
  return SCRIPT_EXT_PATTERN.test(name);
}

function isScriptsDirEntry(relativePath: string): boolean {
  // 任意路径段等于 "scripts" 即视为存在 scripts/ 目录（顶层或嵌套均可）
  const normalized = relativePath.replace(SEP_RE, '/');
  return normalized.split('/').some((seg) => seg === 'scripts');
}

/**
 * 给定扁平的文件清单，判断 Skill 是否属于"可执行"范畴：
 *  - hasScripts：任意深度出现 `scripts/` 目录
 *  - hasExecutableExt：任意文件具有已知脚本扩展名
 *
 * Skill 永远不能扩展 Agent 的 toolIds：所有越权请求必须降级为
 * `requires-runtime` 或在解析阶段被丢弃（见 `bindings.ts`）。
 */
export function classifyFromFiles(files: string[]): { hasScripts: boolean; hasExecutableExt: boolean } {
  let hasScripts = false;
  let hasExecutableExt = false;
  for (const f of files) {
    if (isScriptsDirEntry(f)) {
      hasScripts = true;
    }
    if (isExecutableFileName(basename(f))) {
      hasExecutableExt = true;
    }
  }
  return { hasScripts, hasExecutableExt };
}

/**
 * 解析 Skill 的最终兼容性。
 *
 *  1. 任何可执行产物（scripts/ 目录或可执行扩展名文件）→ `requires-runtime`
 *     （不可绑定 / 不可注入）。
 *  2. Skill 的 `allowed-tools` 未在 Tool Registry 注册 → `requires-runtime`
 *     （无法满足）。
 *  3. `allowed-tools` 已注册但目标 Agent 的 `toolIds` 不包含 → 对该 Agent
 *     视为 `requires-runtime`。
 *  4. 其它 → `compatible`。
 *
 * `agentId` 可选：传入以把校验限定到某个具体 Agent；省略时为"对任何 Agent
 * 是否都可绑定"的全局判定。
 */
export function analyzeCompatibility(
  files: string[],
  allowedTools?: string[],
  agentId?: string,
): { compatibility: 'compatible' | 'requires-runtime'; reason: string } {
  const { hasScripts, hasExecutableExt } = classifyFromFiles(files);
  if (hasScripts || hasExecutableExt) {
    return { compatibility: 'requires-runtime', reason: 'contains executable files' };
  }
  const registeredToolIds = new Set(listToolDefinitions().map((t) => t.id));
  if (allowedTools && allowedTools.length > 0) {
    const missing = allowedTools.filter((t) => !registeredToolIds.has(t));
    if (missing.length > 0) {
      return {
        compatibility: 'requires-runtime',
        reason: `requested tools not registered: ${missing.join(', ')}`,
      };
    }
    if (agentId) {
      const def = getAgentDefinition(agentId);
      if (!def) {
        return { compatibility: 'requires-runtime', reason: 'agent not found' };
      }
      const agentToolIds = new Set(def.toolIds ?? []);
      const notInAgent = allowedTools.filter((t) => !agentToolIds.has(t));
      if (notInAgent.length > 0) {
        return {
          compatibility: 'requires-runtime',
          reason: `agent ${agentId} does not have tools: ${notInAgent.join(', ')}`,
        };
      }
    }
  }
  return { compatibility: 'compatible', reason: 'ok' };
}
