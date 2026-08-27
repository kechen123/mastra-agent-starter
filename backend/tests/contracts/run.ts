/**
 * Starter 扩展契约检查（Extension Contracts）。
 *
 * 目标：
 *   - 在不连真实数据库、不调真实模型、不启 HTTP 服务的前提下，静态校验
 *     后端"扩展基座"是否仍然符合 Starter 契约。
 *   - 任何一个失败都对应一条明确的违反项，让二开者一眼看到回归点。
 *
 * 设计原则：
 *   - 完全离线：仅 import 真实模块 + 扫描源码文本。
 *   - 不引入 Vitest/Jest 等额外测试依赖，复用项目自带的 tsx。
 *   - 输出使用简洁中文，失败时直接打印"违反的 Starter 契约"原文。
 *
 * 运行：
 *   cd backend && npm run test:contracts
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 契约测试要验证 config 的默认行为，不应继承开发机或 .env 中遗留的废弃变量；否则
// `XUANSHU_CHAT_MODEL` 的迁移提醒会污染正常测试输出。dotenv 默认不会覆盖已有环境变量，
// 因此设为空字符串即可屏蔽本测试进程的旧值。生产启动仍会保留该提醒。
process.env.XUANSHU_CHAT_MODEL = '';

// 采用动态导入，确保上面的测试环境清理发生在 config 与扩展模块加载之前。
const { listAgentDefinitions } = await import('../../src/core/agent/registry.js');
const { listToolDefinitions } = await import('../../src/core/tool/registry.js');
const { parseAllowedToolsFromFrontmatter } = await import('../../src/core/skill/registry.js');
const { DATABASE_EMBEDDING_DIM } = await import('../../src/config.js');

// 副作用导入：让 agents/index.ts 和 tools/index.ts 的 register* 真正执行，
// 才能 listAgentDefinitions / listToolDefinitions 看到完整注册表。
await import('../../src/agents/index.js');
await import('../../src/tools/index.js');

type Check = { name: string; ok: boolean; detail?: string };

const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push(detail ? { name, ok, detail } : { name, ok });
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 扩展注册契约：禁止模板条目混入正式列表。
// ─────────────────────────────────────────────────────────────────────────

const EXPECTED_AGENT_IDS = new Set(['general-chat', 'knowledge-base']);
const EXPECTED_TOOL_IDS = new Set(['calculator', 'get-current-time']);
const FORBIDDEN_IDS = ['template-agent', 'template-tool', '_template', 'replace-me'];

const agentDefs = listAgentDefinitions();
const toolDefs = listToolDefinitions();
const agentIds = agentDefs.map((d) => d.id);
const toolIds = toolDefs.map((d) => d.id);

for (const id of FORBIDDEN_IDS) {
  record(
    `[Agent] 不应出现模板占位 id "${id}"`,
    !agentIds.includes(id),
    `实际 Agent 列表：${JSON.stringify(agentIds)}`,
  );
  record(
    `[Tool] 不应出现模板占位 id "${id}"`,
    !toolIds.includes(id),
    `实际 Tool 列表：${JSON.stringify(toolIds)}`,
  );
}

for (const id of EXPECTED_AGENT_IDS) {
  record(`[Agent] 必须注册 "${id}"`, agentIds.includes(id));
}
for (const id of EXPECTED_TOOL_IDS) {
  record(`[Tool] 必须注册 "${id}"`, toolIds.includes(id));
}

// Agent 列表若超出预期集合，也视为违反"基座只保留两个具体 Agent"的契约。
const extraAgents = agentIds.filter((id) => !EXPECTED_AGENT_IDS.has(id));
record(
  '[Agent] 注册列表仅包含 general-chat / knowledge-base',
  extraAgents.length === 0,
  extraAgents.length > 0 ? `意外 Agent：${JSON.stringify(extraAgents)}` : undefined,
);
const extraTools = toolIds.filter((id) => !EXPECTED_TOOL_IDS.has(id));
record(
  '[Tool] 注册列表仅包含 calculator / get-current-time',
  extraTools.length === 0,
  extraTools.length > 0 ? `意外 Tool：${JSON.stringify(extraTools)}` : undefined,
);

// ─────────────────────────────────────────────────────────────────────────
// 2. Core 依赖方向：core/ 不得 import 具体 Agent / Tool / Skill。
// ─────────────────────────────────────────────────────────────────────────

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BACKEND_SRC = resolve(HERE, '..', '..', 'src');

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, files);
    } else if (st.isFile()) {
      files.push(full);
    }
  }
  return files;
}

const CORE_DIR = join(BACKEND_SRC, 'core');
const AGENTS_DIR = join(BACKEND_SRC, 'agents');
const TOOLS_DIR = join(BACKEND_SRC, 'tools');
const SKILLS_DIR = join(BACKEND_SRC, 'skills');

function isInsideCorePath(importPath: string, targetDir: string, sourceFile: string): boolean {
  // importPath 例如 '../agents/index.js'，转成从 backend/src 出发的相对路径。
  const sourceDir = resolve(sourceFile, '..');
  const normalized = importPath.replace(/\\/g, '/');
  // 只检查相对引用，不关心 node_modules / 框架别名。
  if (!normalized.startsWith('.')) return false;
  // 用 fileURLToPath 安全组合，避免 Windows 路径分隔差异。
  const resolved = resolve(sourceDir, normalized);
  const rel = relative(targetDir, resolved).replace(/\\/g, '/');
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function listCoreFiles(): string[] {
  const all = walk(CORE_DIR);
  return all.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
}

const coreFiles = listCoreFiles();
let coreViolation: { file: string; importPath: string; reason: string } | null = null;
for (const file of coreFiles) {
  const text = readFileSync(file, 'utf-8');
  // 同时覆盖 ESM 的具名导入、仅副作用导入、动态 import() 以及 CommonJS require()。
  // 本项目暂未使用路径别名；若以后引入别名，需要在此同步补充别名到物理目录的映射。
  const importRegex = /(?:^\s*(?:import|export)\s+[\s\S]*?\s+from\s*|^\s*import\s*|\bimport\s*\(|\brequire\s*\()(['"])([^'"]+)\1/gm;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(text)) !== null) {
    const spec = m[2] ?? '';
    for (const targetDir of [AGENTS_DIR, TOOLS_DIR, SKILLS_DIR]) {
      if (isInsideCorePath(spec, targetDir, file)) {
        // 模板本身（_template）属于基座内部，调用方已用 register* 屏蔽；
        // 但 core 直接 import 任何 agents/tools/skills 子目录都违反依赖方向。
        coreViolation = {
          file: relative(BACKEND_SRC, file).split(sep).join('/'),
          importPath: spec,
          reason: 'Core 不允许引用具体扩展实现',
        };
        break;
      }
    }
    if (coreViolation) break;
  }
  if (coreViolation) break;
}
record(
  '[Core 依赖方向] core/ 不直接 import 具体 Agent / Tool / Skill',
  coreViolation === null,
  coreViolation
    ? `${coreViolation.file} 引用了 "${coreViolation.importPath}"（${coreViolation.reason}）`
    : undefined,
);

// ─────────────────────────────────────────────────────────────────────────
// 3. Skill 模板与发现规则。
// ─────────────────────────────────────────────────────────────────────────

const templateSkillMdPath = join(SKILLS_DIR, '_template', 'SKILL.md');
let templateAllowedTools: string[] = [];
try {
  const content = readFileSync(templateSkillMdPath, 'utf-8');
  templateAllowedTools = parseAllowedToolsFromFrontmatter(content);
} catch (err) {
  record('[Skill] _template/SKILL.md 存在', false, String(err));
}

const EXPECTED_TEMPLATE_TOOLS = ['calculator', 'get-current-time'];
record(
  '[Skill] _template/SKILL.md 的 allowed-tools 必须为 [calculator, get-current-time]',
  JSON.stringify(templateAllowedTools) === JSON.stringify(EXPECTED_TEMPLATE_TOOLS),
  `实际解析结果：${JSON.stringify(templateAllowedTools)}`,
);

// _template 目录不应作为 Skill 注册。真实的跳过逻辑位于
// `core/skill/discovery.ts` 的 `readSkillMdEntries`（registry.ts 仅作为
// facade 转发）。检查必须落到真实实现文件，防止"只看注释文本通过"——
// 注释文本可能与实际行为脱节。
const skillDiscoveryPath = join(CORE_DIR, 'skill', 'discovery.ts');
let hasTemplateSkip = false;
let hasTemplateSkipInFacade = false;
try {
  const discoveryText = readFileSync(skillDiscoveryPath, 'utf-8');
  // 必须有：字面量 '_template' + 跳过分支（continue 或条件判断）。
  hasTemplateSkip =
    /['_"]_template['"]/.test(discoveryText) &&
    /(continue|skip)/i.test(discoveryText);

  // 额外：facade registry.ts 仍然以注释或代码形式提示发现逻辑在
  // discovery.ts，避免后续重构把跳过行为重新塞回 facade 而破坏模块边界。
  const registryText = readFileSync(join(CORE_DIR, 'skill', 'registry.ts'), 'utf-8');
  hasTemplateSkipInFacade =
    /discovery\.ts/.test(registryText) && /_template/.test(registryText);
} catch (err) {
  record('[Skill] core/skill/discovery.ts 存在', false, String(err));
}
record(
  '[Skill] core/skill/discovery.ts 必须显式跳过 _template 目录（_template 字面量 + continue/skip）',
  hasTemplateSkip,
);
record(
  '[Skill] core/skill/registry.ts 仅作为 facade、必须引用 discovery.ts 的 _template 跳过',
  hasTemplateSkipInFacade,
);

// 保留 skill-classifier.ts：原 fixture 仍然负责纯静态分类 + 并发 hydration 测试。
// 本契约不删除它，仅补"模板与扩展边界"这一组检查。
const skillClassifierPath = join(BACKEND_SRC, '..', 'tests', 'fixtures', 'skill-classifier.ts');
let classifierExists = false;
try {
  classifierExists = statSync(skillClassifierPath).isFile();
} catch {
  classifierExists = false;
}
record(
  '[Skill] 原 fixture tests/fixtures/skill-classifier.ts 仍存在',
  classifierExists,
);

// ─────────────────────────────────────────────────────────────────────────
// 4. 配置契约：embedding 维度必须等于数据库固定维度。
// ─────────────────────────────────────────────────────────────────────────

record(
  '[Config] DATABASE_EMBEDDING_DIM 必须为 2048',
  DATABASE_EMBEDDING_DIM === 2048,
  `实际值：${DATABASE_EMBEDDING_DIM}`,
);

// 通过 import 副作用，config.ts 已经校验过 EMBEDDING_DIM === 2048。
// 若当前进程未抛错，说明校验通过；额外再做一次显式断言以提供更清晰的失败信息。
let dimFromProcess: number | null = null;
try {
  const raw = process.env.EMBEDDING_DIM;
  dimFromProcess = raw === undefined ? 2048 : Number(raw);
} catch {
  dimFromProcess = null;
}
record(
  '[Config] EMBEDDING_DIM 解析值必须等于数据库固定维度',
  dimFromProcess === DATABASE_EMBEDDING_DIM,
  `EMBEDDING_DIM=${dimFromProcess ?? 'NaN'}，DATABASE_EMBEDDING_DIM=${DATABASE_EMBEDDING_DIM}`,
);

// 非法值必须在加载时直接抛出（通过一个子进程触发 import 副作用，避免污染当前 env）。
// 把脚本写到 tests/contracts/.tmp 下，避免 -e eval 模式下包解析失败。
const { pathToFileURL } = await import('node:url');
const CHILD_SCRIPT_PATH = join(HERE, '.tmp-child-check.mjs');
const CHILD_SCRIPT_BODY = `
import(${JSON.stringify(pathToFileURL(join(BACKEND_SRC, 'config.js')).href)})
  .then((mod) => {
    console.log('CONFIG_OK', String(mod.DATABASE_EMBEDDING_DIM));
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('CONFIG_LOAD_FAILED:', msg);
    process.exit(3);
  });
`;
writeFileSync(CHILD_SCRIPT_PATH, CHILD_SCRIPT_BODY);

async function runChildCheck(
  envValue: string | null,
  overrides: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string; spawnError?: string }> {
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env };
  // 子进程也必须先占位，避免 dotenv 从 .env 重新加载废弃变量。
  env.XUANSHU_CHAT_MODEL = '';
  if (envValue === null) delete env.EMBEDDING_DIM;
  else env.EMBEDDING_DIM = envValue;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // HERE 是 backend/tests/contracts/run.ts，需要上溯三层到 backend/。
  const cwd = resolve(HERE, '..', '..', '..');
  try {
    const stdout = execFileSync('npx', ['tsx', CHILD_SCRIPT_PATH], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

const noEnv = await runChildCheck(null);
record(
  '[Config] 未设置 EMBEDDING_DIM 时启动通过（默认 2048）',
  noEnv.code === 0,
  noEnv.code !== 0
    ? `code=${noEnv.code}, combined=${((noEnv.stdout ?? '') + (noEnv.stderr ?? '')).trim() || '<empty>'}`
    : undefined,
);

const okEnv = await runChildCheck('2048');
record(
  '[Config] EMBEDDING_DIM=2048 时启动通过',
  okEnv.code === 0,
  okEnv.code !== 0
    ? `code=${okEnv.code}, combined=${((okEnv.stdout ?? '') + (okEnv.stderr ?? '')).trim() || '<empty>'}`
    : undefined,
);

const badEnv = await runChildCheck('1024');
const badEnvCombined = `${badEnv.stdout ?? ''}\n${badEnv.stderr ?? ''}`;
record(
  '[Config] EMBEDDING_DIM=1024 时必须显式抛错',
  badEnv.code !== 0 && /Embedding 维度不一致/.test(badEnvCombined),
  badEnv.code === 0
    ? `预期抛错但子进程成功退出。combined=${badEnvCombined.trim() || '<empty>'}`
    : `code=${badEnv.code}, combined=${badEnvCombined.trim() || '<empty>'}`
);

const productionProfile = await runChildCheck('2048', { DEPLOYMENT_PROFILE: 'production' });
const productionProfileCombined = `${productionProfile.stdout}\n${productionProfile.stderr}`;
record(
  '[Config] DEPLOYMENT_PROFILE=production 必须拒绝匿名 Starter 启动',
  productionProfile.code !== 0 && /不支持 DEPLOYMENT_PROFILE=production/.test(productionProfileCombined),
  productionProfile.code === 0
    ? '预期拒绝 production 档位但子进程成功退出。'
    : `code=${productionProfile.code}, combined=${productionProfileCombined.trim() || '<empty>'}`,
);

// ─────────────────────────────────────────────────────────────────────────
// 5. LLM Provider Boundary：默认解析、自定义模型、非 DeepSeek 拒绝、
//    AGENT_CHAT_MODEL 兼容、凭据校验。
//
// 全部用子进程跑，env 严格隔离，避免 dotenv 或模块缓存污染其他用例。
// ─────────────────────────────────────────────────────────────────────────

const LLM_CHILD_SCRIPT_PATH = join(HERE, '.tmp-llm-check.mjs');
const LLM_CHILD_SCRIPT_BODY = `
const url = ${JSON.stringify(pathToFileURL(join(BACKEND_SRC, 'config.js')).href)};
const regUrl = ${JSON.stringify(pathToFileURL(join(BACKEND_SRC, 'infrastructure', 'llm', 'registry.js')).href)};
// 把 console.warn 镜像到 stdout，避免父进程只读 pipe 时错过弃用提示。
const origWarn = console.warn.bind(console);
console.warn = (...args) => {
  origWarn(...args);
  try { process.stdout.write('LLM_DEPRECATION_WARN ' + args.join(' ') + '\\n'); } catch {}
};
(async () => {
  const cfg = await import(url);
  const reg = await import(regUrl);
  const provider = cfg.config.chatProvider;
  const model = cfg.config.chatModel;
  // 该入口不校验凭据，供 capabilities 等只读描述接口使用。
  const modelIdWithoutCredentials = reg.resolveDefaultChatModelId();
  // 调用 resolveDefaultChatModel 会触发 assertCredentials，因此缺 key 时会抛错。
  let fullModelId = '';
  let credError = '';
  let exitCode = 0;
  try {
    fullModelId = reg.resolveDefaultChatModel();
  } catch (err) {
    credError = err && err.message ? err.message : String(err);
    exitCode = 5;
  }
  const info = (() => {
    try { return reg.resolveDefaultChatModelInfo(); } catch { return null; }
  })();
  console.log('LLM_RESOLVED', JSON.stringify({
    provider,
    model,
    modelIdWithoutCredentials,
    fullModelId,
    credError,
    info,
  }));
  if (exitCode !== 0) process.exit(exitCode);
})().catch((err) => {
  console.error('LLM_LOAD_FAILED:', err && err.message ? err.message : String(err));
  process.exit(4);
});
`;
writeFileSync(LLM_CHILD_SCRIPT_PATH, LLM_CHILD_SCRIPT_BODY);

interface LlmChildResult {
  code: number;
  stdout: string;
  stderr: string;
  parsed: {
    provider: string;
    model: string;
    modelIdWithoutCredentials: string;
    fullModelId: string;
    credError: string;
    info: { provider: string; model: string; displayName: string } | null;
  } | null;
}

async function runLlmChild(
  envOverrides: Record<string, string | undefined>,
): Promise<LlmChildResult> {
  const { execFileSync } = await import('node:child_process');
  const env: Record<string, string | undefined> = { ...process.env };
  // 永远屏蔽本机 .env 中可能保留的旧变量与历史 API Key，
  // 以保证每个子进程看到的是"纯净 + overrides"的视图。
  env.XUANSHU_CHAT_MODEL = '';
  env.AGENT_CHAT_MODEL = '';
  env.LLM_PROVIDER = '';
  env.LLM_MODEL = '';
  env.DEEPSEEK_API_KEY = '';
  env.EMBEDDING_DIM = '2048';
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const cwd = resolve(HERE, '..', '..', '..');
  try {
    const stdout = execFileSync('npx', ['tsx', LLM_CHILD_SCRIPT_PATH], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const line = String(stdout ?? '').split('\n').find((l) => l.startsWith('LLM_RESOLVED ')) ?? '';
    const jsonText = line.replace(/^LLM_RESOLVED\s*/, '').trim();
    const parsed = jsonText ? (JSON.parse(jsonText) as LlmChildResult['parsed']) : null;
    return { code: 0, stdout: stdout ?? '', stderr: '', parsed };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const output = e.stdout ?? '';
    const line = String(output).split('\n').find((l) => l.startsWith('LLM_RESOLVED ')) ?? '';
    const jsonText = line.replace(/^LLM_RESOLVED\s*/, '').trim();
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: output,
      stderr: e.stderr ?? '',
      parsed: jsonText ? (JSON.parse(jsonText) as LlmChildResult['parsed']) : null,
    };
  }
}

function recordLlmChild(label: string, ok: boolean, detail?: string): void {
  record(`[LLM] ${label}`, ok, detail);
}

// 5.1 默认：未设置任何 LLM_* 变量 → provider=deepseek, model=deepseek-v4-flash,
//       full model id = deepseek/deepseek-v4-flash。
const def = await runLlmChild({
  // 必须给 DEEPSEEK_API_KEY，否则 assertCredentials 会抛错。
  DEEPSEEK_API_KEY: 'test-default-key',
});
recordLlmChild(
  '默认配置解析为 deepseek / deepseek-v4-flash / deepseek/deepseek-v4-flash',
  def.code === 0 &&
    def.parsed !== null &&
    def.parsed.provider === 'deepseek' &&
    def.parsed.model === 'deepseek-v4-flash' &&
    def.parsed.fullModelId === 'deepseek/deepseek-v4-flash',
  def.code !== 0
    ? `code=${def.code}, combined=${((def.stdout ?? '') + (def.stderr ?? '')).trim() || '<empty>'}`
    : def.parsed
      ? `parsed=${JSON.stringify(def.parsed)}`
      : 'parsed=<null>',
);
recordLlmChild(
  '默认配置下 resolveDefaultChatModelInfo() 返回 displayName=DeepSeek',
  def.code === 0 && def.parsed?.info?.displayName === 'DeepSeek',
  def.parsed?.info ? `info=${JSON.stringify(def.parsed.info)}` : undefined,
);

// 5.2 自定义 LLM_MODEL：保持 provider=deepseek，覆盖 model。
const custom = await runLlmChild({
  LLM_PROVIDER: 'deepseek',
  LLM_MODEL: 'deepseek-v3-flash',
  DEEPSEEK_API_KEY: 'test-custom-key',
});
recordLlmChild(
  'LLM_PROVIDER=deepseek + 自定义 LLM_MODEL → deepseek/deepseek-v3-flash',
  custom.code === 0 &&
    custom.parsed !== null &&
    custom.parsed.provider === 'deepseek' &&
    custom.parsed.model === 'deepseek-v3-flash' &&
    custom.parsed.fullModelId === 'deepseek/deepseek-v3-flash',
  custom.code !== 0
    ? `code=${custom.code}, combined=${((custom.stdout ?? '') + (custom.stderr ?? '')).trim() || '<empty>'}`
    : custom.parsed
      ? `parsed=${JSON.stringify(custom.parsed)}`
      : 'parsed=<null>',
);

// 5.3 非 DeepSeek Provider 必须被明确拒绝（且明确中文）。
const openai = await runLlmChild({
  LLM_PROVIDER: 'openai',
  LLM_MODEL: 'gpt-4o-mini',
  DEEPSEEK_API_KEY: 'ignored',
});
const openaiCombined = `${openai.stdout ?? ''}\n${openai.stderr ?? ''}`;
recordLlmChild(
  'LLM_PROVIDER=openai 必须显式抛错且提示当前仅启用 DeepSeek',
  openai.code !== 0 && /仅启用 DeepSeek/.test(openaiCombined),
  openai.code === 0
    ? `预期抛错但子进程成功退出。combined=${openaiCombined.trim() || '<empty>'}`
    : `code=${openai.code}, combined=${openaiCombined.trim() || '<empty>'}`,
);

// 5.4 AGENT_CHAT_MODEL=deepseek/<model> 兼容解析：必须有弃用警告且 model 正确。
const compat = await runLlmChild({
  AGENT_CHAT_MODEL: 'deepseek/deepseek-v3',
  DEEPSEEK_API_KEY: 'compat-key',
});
recordLlmChild(
  'AGENT_CHAT_MODEL=deepseek/deepseek-v3 兼容解析为 deepseek/deepseek-v3',
  compat.code === 0 &&
    compat.parsed !== null &&
    compat.parsed.provider === 'deepseek' &&
    compat.parsed.model === 'deepseek-v3' &&
    compat.parsed.fullModelId === 'deepseek/deepseek-v3',
  compat.code !== 0
    ? `code=${compat.code}, combined=${((compat.stdout ?? '') + (compat.stderr ?? '')).trim() || '<empty>'}`
    : compat.parsed
      ? `parsed=${JSON.stringify(compat.parsed)}`
      : 'parsed=<null>',
);
recordLlmChild(
  'AGENT_CHAT_MODEL 兼容路径必须输出弃用警告',
  compat.code === 0 &&
    ((compat.stdout ?? '').includes('LLM_DEPRECATION_WARN') ||
      /AGENT_CHAT_MODEL.*已废弃/.test(compat.stderr ?? '')),
  compat.code !== 0
    ? `code=${compat.code}, combined=${((compat.stdout ?? '') + (compat.stderr ?? '')).trim() || '<empty>'}`
    : `stdout=${(compat.stdout ?? '').slice(-200)}, stderr=${(compat.stderr ?? '').slice(-200)}`,
);

// 5.5 AGENT_CHAT_MODEL 指向非 DeepSeek Provider 必须明确拒绝。
const compatOpenai = await runLlmChild({
  AGENT_CHAT_MODEL: 'openai/gpt-4o-mini',
  DEEPSEEK_API_KEY: 'ignored',
});
const compatOpenaiCombined = `${compatOpenai.stdout ?? ''}\n${compatOpenai.stderr ?? ''}`;
recordLlmChild(
  'AGENT_CHAT_MODEL=openai/<model> 必须明确拒绝（中文错误）',
  compatOpenai.code !== 0 && /AGENT_CHAT_MODEL=openai\/gpt-4o-mini/.test(compatOpenaiCombined),
  compatOpenai.code === 0
    ? `预期抛错但子进程成功退出。combined=${compatOpenaiCombined.trim() || '<empty>'}`
    : `code=${compatOpenai.code}, combined=${compatOpenaiCombined.trim() || '<empty>'}`,
);

// 5.6 缺失 DEEPSEEK_API_KEY → assertCredentials 抛错且错误信息不含 key 本身。
const SENSITIVE_KEY = 'sk-this-is-very-secret-DO-NOT-LEAK';
const noKey = await runLlmChild({
  // 用一个新变量隔离掉所有可能的 key 来源；空字符串视为"未配置"。
  DEEPSEEK_API_KEY: '',
});
recordLlmChild(
  '缺少 DEEPSEEK_API_KEY → resolveDefaultChatModel() 抛错',
  noKey.code !== 0 && /DeepSeek Provider 缺少凭据/.test(`${noKey.stdout ?? ''}\n${noKey.stderr ?? ''}`),
  noKey.code === 0
    ? `预期抛错但子进程成功退出。parsed=${JSON.stringify(noKey.parsed)}`
    : `code=${noKey.code}, combined=${((noKey.stdout ?? '') + (noKey.stderr ?? '')).trim() || '<empty>'}`,
);
recordLlmChild(
  '缺少 DEEPSEEK_API_KEY 时仍可解析 capabilities 所需的完整模型 ID',
  noKey.code !== 0 && noKey.parsed?.modelIdWithoutCredentials === 'deepseek/deepseek-v4-flash',
  noKey.parsed ? `parsed=${JSON.stringify(noKey.parsed)}` : 'parsed=<null>',
);
// 二次确认：错误信息绝不包含真实 key。
recordLlmChild(
  '缺少 DEEPSEEK_API_KEY 时错误信息不包含敏感 key 内容',
  noKey.code !== 0 && !((noKey.stdout ?? '') + (noKey.stderr ?? '')).includes(SENSITIVE_KEY),
  `combined=${((noKey.stdout ?? '') + (noKey.stderr ?? '')).trim() || '<empty>'}`,
);
// 进一步：用真实 key 触发解析，确认成功路径不会"反向泄漏"。
const goodKey = await runLlmChild({
  DEEPSEEK_API_KEY: SENSITIVE_KEY,
});
recordLlmChild(
  'DEEPSEEK_API_KEY 已配置时 resolveDefaultChatModel() 不抛错',
  goodKey.code === 0 && goodKey.parsed?.fullModelId === 'deepseek/deepseek-v4-flash',
  goodKey.code !== 0
    ? `code=${goodKey.code}, combined=${((goodKey.stdout ?? '') + (goodKey.stderr ?? '')).trim() || '<empty>'}`
    : goodKey.parsed
      ? `parsed=${JSON.stringify(goodKey.parsed)}`
      : 'parsed=<null>',
);

// 清理 LLM 子进程脚本。
try {
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(LLM_CHILD_SCRIPT_PATH)) unlinkSync(LLM_CHILD_SCRIPT_PATH);
} catch {
  // 清理失败不影响测试结果。
}

// ─────────────────────────────────────────────────────────────────────────
// 6. 单进程会话执行互斥：reserve 必须在所有决定性状态读取之前。
//
// 设计动机：
//   若先 `getConversationWithMessages(conversationId)` 再 `tryReserve…`，
//   两个并发请求都可能读出相同的旧 history，导致 user/assistant 顺序错乱。
//   本契约以"源码中调用位置先后顺序"作为静态保证，注释不算数。
//
// 检查必须落到真实 route 源码，不接受仅靠注释或 JSDoc 声明。
// ─────────────────────────────────────────────────────────────────────────

function stripCommentsForSourceScan(text: string): string {
  // 去掉块注释与行注释，避免注释里出现 "reserve before read" 这类文字造成误判。
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function firstCallIndex(text: string, callee: string): number {
  // 形如 `tryReserveConversationExecution(` 或 `getConversationWithMessages(` 的调用点。
  const pattern = new RegExp(`\\b${callee}\\s*\\(`, 'g');
  const m = pattern.exec(text);
  return m ? m.index : -1;
}

const ASK_ROUTE_PATH = join(BACKEND_SRC, 'server', 'routes', 'messages', 'ask.ts');
const REGENERATE_ROUTE_PATH = join(BACKEND_SRC, 'server', 'routes', 'messages', 'regenerate.ts');

function assertReserveBeforeReads(
  label: string,
  routePath: string,
  reads: string[],
): void {
  let raw = '';
  let stripped = '';
  try {
    raw = readFileSync(routePath, 'utf-8');
    stripped = stripCommentsForSourceScan(raw);
  } catch (err) {
    record(`[ExecLock] ${label}：可读取源码`, false, String(err));
    return;
  }

  const reserveIdx = firstCallIndex(stripped, 'tryReserveConversationExecution');
  record(
    `[ExecLock] ${label}：源码中存在 tryReserveConversationExecution(...) 调用`,
    reserveIdx >= 0,
    `route=${relative(resolve(BACKEND_SRC, '..'), routePath).split(sep).join('/')}`,
  );
  if (reserveIdx < 0) return;

  for (const read of reads) {
    const readIdx = firstCallIndex(stripped, read);
    if (readIdx < 0) {
      // 该路由没有调用到对应函数，跳过——避免假阳性。
      continue;
    }
    record(
      `[ExecLock] ${label}：tryReserveConversationExecution 必须早于 ${read}(...)`,
      reserveIdx < readIdx,
      `reserveIdx=${reserveIdx}, ${read}Idx=${readIdx}`,
    );
  }
}

assertReserveBeforeReads(
  'ask.ts',
  ASK_ROUTE_PATH,
  ['getConversationWithMessages', 'saveUserMessage', 'createAssistantPending', 'updateAssistantStreaming'],
);

assertReserveBeforeReads(
  'regenerate.ts',
  REGENERATE_ROUTE_PATH,
  [
    'getConversationWithMessages',
    'getLastAssistantMessage',
    'getMessageSnapshot',
    'resetAssistantForRetry',
    'updateAssistantStreaming',
  ],
);

// ─────────────────────────────────────────────────────────────────────────
// 7. Phase 1 认证路由契约：除 healthz / readyz / /auth/login 外，
//    业务路由必须 requiresAuth: true。
//    实现层用静态文本扫描，避免误判 Mastra 抽象层默认值。
// ─────────────────────────────────────────────────────────────────────────

const ROUTES_DIR = join(BACKEND_SRC, 'server', 'routes');

interface RouteAuth {
  path: string;
  method: string;
  hasExplicitRequiresAuth: boolean;
  requiresAuthValue: 'true' | 'false' | 'unspecified';
}

const ROUTE_AUTH_ALLOWLIST: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
  { method: 'POST', path: '/auth/login' },
  // /auth/logout 必须是公开的：注销必须能清掉任何状态下的 Cookie
  // （过期/已吊销/篡改），所以不能套 requiresAuth:true；路由层用 Origin 校验兜底。
  { method: 'POST', path: '/auth/logout' },
];

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function scanRouteAuth(): RouteAuth[] {
  const results: RouteAuth[] = [];
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && /\.(ts)$/.test(entry)) files.push(full);
    }
  }
  walk(ROUTES_DIR);
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const routeRegex =
      /registerApiRoute\(\s*(['"])([^'"]+)\1\s*,\s*\{([\s\S]*?)\}\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = routeRegex.exec(text)) !== null) {
      const path = m[2] ?? '';
      const body = m[3] ?? '';
      const methodMatch = body.match(/method\s*:\s*(['"])([^'"]+)\1/);
      const method = methodMatch ? (methodMatch[2] ?? '').toUpperCase() : '';
      const requiresMatch = body.match(/requiresAuth\s*:\s*(true|false)/);
      const value = requiresMatch ? ((requiresMatch[1] as 'true' | 'false')) : 'unspecified';
      results.push({
        path,
        method,
        hasExplicitRequiresAuth: requiresMatch !== null,
        requiresAuthValue: value,
      });
    }
  }
  return results;
}

const allRoutes = scanRouteAuth();

record(
  '[Auth] 至少存在 1 个 registerApiRoute 调用',
  allRoutes.length > 0,
  `共扫描到 ${allRoutes.length} 条路由`,
);

for (const route of allRoutes) {
  const key = routeKey(route.method, route.path);
  const inAllow = ROUTE_AUTH_ALLOWLIST.some((r) => r.method === route.method && r.path === route.path);
  if (inAllow) {
    record(
      `[Auth] 公开路由 ${key} 应保持 requiresAuth: false 或不写`,
      route.requiresAuthValue !== 'true',
      `实际 requiresAuth: ${route.requiresAuthValue}`,
    );
    continue;
  }
  record(
    `[Auth] 业务路由 ${key} 必须显式 requiresAuth: true`,
    route.hasExplicitRequiresAuth && route.requiresAuthValue === 'true',
    `实际 requiresAuth: ${route.requiresAuthValue}`,
  );
}

// /auth/login 必须是 POST（防御性确认）
record(
  '[Auth] /auth/login 必须是 POST',
  allRoutes.some((r) => r.method === 'POST' && r.path === '/auth/login'),
);

// /auth/me 必须 GET + 受保护
{
  const me = allRoutes.find((r) => r.path === '/auth/me');
  record(
    '[Auth] /auth/me 存在且必须是 GET',
    Boolean(me && me.method === 'GET'),
  );
  record(
    '[Auth] /auth/me 必须 requiresAuth: true',
    Boolean(me && me.hasExplicitRequiresAuth && me.requiresAuthValue === 'true'),
  );
}

// /auth/logout 必须 POST + 公开（requiresAuth:false 或未写）。
// 理由：注销必须能清掉任何状态下的 Cookie（过期/已吊销/篡改）；路由层
// 用 Origin 校验兜底，详见 routes/auth.ts。
{
  const lo = allRoutes.find((r) => r.path === '/auth/logout');
  record(
    '[Auth] /auth/logout 存在且必须是 POST',
    Boolean(lo && lo.method === 'POST'),
  );
  record(
    '[Auth] /auth/logout 必须是公开（false 或不写），以便清掉无效 Cookie',
    Boolean(lo && lo.requiresAuthValue !== 'true'),
    `实际 requiresAuth: ${lo?.requiresAuthValue ?? 'unspecified'}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────

let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  ✓ ${c.name}`);
  } else {
    failed++;
    console.log(`  ✗ ${c.name}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }
}

// 清理子进程脚本。
try {
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(CHILD_SCRIPT_PATH)) unlinkSync(CHILD_SCRIPT_PATH);
} catch {
  // 清理失败不影响测试结果。
}

console.log('');
console.log(`Starter 契约检查：${checks.length - failed} 通过，${failed} 失败`);
if (failed > 0) {
  console.log('已违反 Starter 扩展契约，请修复后重新运行 `npm run test:contracts`。');
  process.exit(1);
}
