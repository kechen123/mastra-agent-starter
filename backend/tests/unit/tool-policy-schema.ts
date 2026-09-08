/**
 * Phase 3.1 + PR-3.3 — Tool Policy / Approval Schema 契约测试（离线）。
 *
 * 目标：让 backend/database/init.sql 中"阶段 3.1 / 3.3 追加段"的 table
 * 定义、CHECK、FK、唯一约束、索引一旦被人误改（例如手贱把
 * `UNIQUE(run_id, tool_call_id)` 删了）就在 CI 上挂掉，**不**连
 * 真实 PostgreSQL、不启动服务、不依赖密钥。
 *
 * 覆盖契约（与 init.sql 阶段 3.1 / 3.3 段一一对应）：
 *   - 存在 tool_policy_rules / tool_approval_requests 两张表；
 *   - tool_policy_rules 含：id UUID PK、workspace_id FK workspaces、
 *     tool_id TEXT、effect CHECK(allow|deny|require_approval)、
 *     conditions JSONB default '{}'::jsonb、created_by FK app_users、
 *     created_at / updated_at TIMESTAMPTZ default now()、
 *     UNIQUE(workspace_id, tool_id)、workspace_id 索引；
 *   - tool_approval_requests 含：id UUID PK、workspace_id FK workspaces、
 *     run_id FK agent_runs、tool_id / tool_call_id / inputs_hash TEXT、
 *     inputs_summary JSONB NOT NULL、
 *     status CHECK(pending|approving|declining|approved|declined|expired)
 *     含中间态、**不**含 rejected；requester_id / resolver_id FK app_users
 *     **可空**（PR-3.3 允许 nullable，让 system-initiated 续 Run 走真实
 *     `system-approval-worker` 平台用户 UUID）、expires_at TIMESTAMPTZ
 *     NOT NULL、created_at default now()、resolved_at TIMESTAMPTZ、
 *     UNIQUE(run_id, tool_call_id)、**不**含 suspension_id 列、
 *     **不**含 UNIQUE(suspension_id)、partial pending 索引、run_id 索引；
 *   - 不存在 agent_runs.approval_request_id 新增（V2.1 决策）。
 *
 * 运行：`cd backend && npx tsx tests/unit/tool-policy-schema.ts`
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const initSql = readFileSync(
  new URL('../../database/init.sql', import.meta.url),
  'utf8',
);

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

console.log('[tool-policy-schema] 表存在 + 列结构');

check(
  'tool_policy_rules 表创建',
  /CREATE TABLE\s+tool_policy_rules\s*\(/i.test(initSql),
);
check(
  'tool_approval_requests 表创建',
  /CREATE TABLE\s+tool_approval_requests\s*\(/i.test(initSql),
);
check(
  'tool_policy_rules.id UUID PK DEFAULT gen_random_uuid()',
  /CREATE TABLE\s+tool_policy_rules[\s\S]*?id\s+UUID\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/i.test(
    initSql,
  ),
);
check(
  'tool_policy_rules.workspace_id UUID FK workspaces(id) ON DELETE CASCADE',
  /tool_policy_rules[\s\S]*?workspace_id\s+UUID\s+NOT NULL\s+REFERENCES\s+workspaces\(id\)\s+ON DELETE\s+CASCADE/i.test(
    initSql,
  ),
);
check(
  'tool_policy_rules.effect CHECK allow|deny|require_approval',
  /effect\s+TEXT\s+NOT NULL[\s\S]*?CHECK\s*\(\s*effect\s+IN\s*\(\s*'allow'\s*,\s*'deny'\s*,\s*'require_approval'\s*\)\s*\)/i.test(
    initSql,
  ),
);
check(
  "tool_policy_rules.conditions JSONB DEFAULT '{}'::jsonb",
  /conditions\s+JSONB\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i.test(initSql),
);
check(
  'tool_policy_rules.created_by UUID NOT NULL REFERENCES app_users(id)',
  /created_by\s+UUID\s+NOT NULL\s+REFERENCES\s+app_users\(id\)/i.test(
    initSql,
  ),
);
check(
  'tool_policy_rules.created_at / updated_at TIMESTAMPTZ DEFAULT now()',
  /created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)[\s\S]*?updated_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/i.test(
    initSql,
  ),
);
check(
  'tool_policy_rules UNIQUE(workspace_id, tool_id)',
  /UNIQUE\s*\(\s*workspace_id\s*,\s*tool_id\s*\)/i.test(initSql),
);

console.log('\n[tool-policy-schema] tool_approval_requests 列 / 约束');

const tar = initSql.match(
  /CREATE TABLE\s+tool_approval_requests\s*\(([\s\S]*?)\n\)/i,
);
assert.ok(tar, '应能匹配 tool_approval_requests 表体');
const tarBody = tar![1];

check(
  'tool_approval_requests.id UUID PK DEFAULT gen_random_uuid()',
  /id\s+UUID\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/.test(tarBody),
);
check(
  'tool_approval_requests.workspace_id UUID FK workspaces(id) ON DELETE CASCADE',
  /workspace_id\s+UUID\s+NOT NULL\s+REFERENCES\s+workspaces\(id\)\s+ON DELETE\s+CASCADE/.test(
    tarBody,
  ),
);
// 复合外键（PR-3.1 完整性修复）：run_id 与 workspace_id 联合指向
// agent_runs(id, workspace_id)，强制审批请求与 Run 同 Workspace。
check(
  'tool_approval_requests 复合外键 (run_id, workspace_id) → agent_runs(id, workspace_id) ON DELETE CASCADE',
  /CONSTRAINT\s+tool_approval_requests_run_workspace_fk[\s\S]+FOREIGN KEY\s*\(\s*run_id\s*,\s*workspace_id\s*\)\s+REFERENCES\s+agent_runs\s*\(\s*id\s*,\s*workspace_id\s*\)\s+ON DELETE\s+CASCADE/i.test(
    tarBody,
  ),
);
// 反向断言：旧的"run_id 单列 → agent_runs(id)"外键不再保留——
// 两套相互独立的 Run FK 已被复合 FK 完全替代。
check(
  'tool_approval_requests.run_id **不**再带单列 REFERENCES agent_runs(id) FK',
  !/run_id\s+UUID\s+NOT NULL\s+REFERENCES\s+agent_runs\(id\)\s+ON DELETE\s+CASCADE/.test(
    tarBody,
  ) &&
    !/run_id[\s\S]+REFERENCES\s+agent_runs\(id\)/i.test(tarBody),
);
// agent_runs 上必须有 UNIQUE(id, workspace_id) 兜底（PR-3.1 完整性修复）：
// 复合 FK 的右侧必须被唯一约束索引；无此 UNIQUE → 复合 FK 创建会失败。
check(
  'agent_runs 持有 UNIQUE(id, workspace_id)（agent_runs_id_workspace_unique）',
  /ALTER\s+TABLE\s+agent_runs\s+ADD\s+CONSTRAINT\s+agent_runs_id_workspace_unique\s+UNIQUE\s*\(\s*id\s*,\s*workspace_id\s*\)/i.test(
    initSql,
  ),
);
check(
  'tool_approval_requests.tool_id TEXT NOT NULL',
  /tool_id\s+TEXT\s+NOT NULL/.test(tarBody),
);
check(
  'tool_approval_requests.tool_call_id TEXT NOT NULL（**不**是 UUID）',
  /tool_call_id\s+TEXT\s+NOT NULL/.test(tarBody) &&
    !/tool_call_id\s+UUID/.test(tarBody),
);
// Mastra 1.61 公开 API（agent.approveToolCall / declineToolCall /
// tool-call-approval 事件）只携带 runId + toolCallId + args，不存在
// 独立可持久化的 suspension token；本阶段不再把 suspension_id 落库。
check(
  'tool_approval_requests **不**再包含 suspension_id 列',
  !/suspension_id\s+TEXT\s+NOT NULL/i.test(tarBody) &&
    !/\bsuspension_id\b/i.test(tarBody),
);
check(
  'tool_approval_requests.inputs_hash TEXT NOT NULL',
  /inputs_hash\s+TEXT\s+NOT NULL/.test(tarBody),
);
check(
  'tool_approval_requests.inputs_summary JSONB NOT NULL（无默认值，强制调用方传入已脱敏摘要）',
  /inputs_summary\s+JSONB\s+NOT NULL(?!\s*DEFAULT)/.test(tarBody),
);
check(
  "tool_approval_requests.status CHECK 包含 approved_resume_indeterminate",
  JSON.stringify([...(tarBody.match(/CHECK\s*\(status IN\s*\(([^)]+)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()) ===
    JSON.stringify(['pending', 'approving', 'declining', 'approved', 'declined', 'expired', 'approved_resume_indeterminate'].sort()),
);
check(
  'tool_approval_requests 枚举**不**出现 rejected',
  !/status\s+IN\s*\(\s*'pending'\s*,\s*'approved'\s*,\s*'rejected'/i.test(
    initSql,
  ),
);
// PR-3.3 — requester_id / resolver_id 均为 NOT NULL FK → app_users(id)。
// 真实审计可追溯：每条审批请求的发起者 / 终结者必须对应一个 app_users
// 行；系统动作（超时 / 续 Run）走 `system-approval-worker` 预设用户 UUID。
check(
  'tool_approval_requests.requester_id UUID NOT NULL REFERENCES app_users(id)',
  /requester_id\s+UUID\s+NOT NULL\s+REFERENCES\s+app_users\(id\)/.test(tarBody),
);
check(
  'tool_approval_requests.resolver_id UUID NOT NULL REFERENCES app_users(id)',
  /resolver_id\s+UUID\s+NOT NULL\s+REFERENCES\s+app_users\(id\)/.test(tarBody),
);
check(
  'tool_approval_requests.expires_at TIMESTAMPTZ NOT NULL',
  /expires_at\s+TIMESTAMPTZ\s+NOT NULL/.test(tarBody),
);
check(
  'tool_approval_requests.created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
  /created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/.test(tarBody),
);
check(
  'tool_approval_requests.resolved_at TIMESTAMPTZ（可空）',
  /resolved_at\s+TIMESTAMPTZ(?!\s+NOT NULL)/.test(tarBody),
);

console.log('\n[tool-policy-schema] 唯一约束 / 索引');

check(
  'tool_approval_requests UNIQUE(run_id, tool_call_id)（审批恢复键）',
  /UNIQUE\s*\(\s*run_id\s*,\s*tool_call_id\s*\)/.test(tarBody),
);
check(
  'tool_approval_requests **不**再带 UNIQUE(suspension_id)',
  !/UNIQUE\s*\(\s*suspension_id\s*\)/i.test(tarBody) &&
    !/CONSTRAINT\s+tool_approval_requests_suspension_unique/i.test(initSql),
);
check(
  'tool_policy_rules workspace 索引存在',
  /CREATE\s+INDEX\s+tool_policy_rules_workspace_idx\s+ON\s+tool_policy_rules\s*\(\s*workspace_id\s*\)/i.test(
    initSql,
  ),
);
check(
  'tool_approval_requests pending workspace 部分索引存在',
  /CREATE\s+INDEX\s+tool_approval_requests_workspace_pending_idx\s+ON\s+tool_approval_requests\s*\(\s*workspace_id\s*,\s*status\s*\)\s+WHERE\s+status\s*=\s*'pending'/i.test(
    initSql,
  ),
);
check(
  'tool_approval_requests run_id 索引存在',
  /CREATE\s+INDEX\s+tool_approval_requests_run_idx\s+ON\s+tool_approval_requests\s*\(\s*run_id\s*\)/i.test(
    initSql,
  ),
);
check(
  'tool_approval_requests expires pending 索引存在（超时 worker 扫描路径）',
  /CREATE\s+INDEX\s+tool_approval_requests_expires_pending_idx\s+ON\s+tool_approval_requests\s*\(\s*expires_at\s*\)\s+WHERE\s+status\s*=\s*'pending'/i.test(
    initSql,
  ),
);

console.log('\n[tool-policy-schema] 跨表约束（V2.1 决策）');

check(
  'init.sql **不**新增 agent_runs.approval_request_id 列',
  !/ALTER\s+TABLE\s+agent_runs[\s\S]+ADD\s+COLUMN\s+approval_request_id/i.test(
    initSql,
  ) &&
    !/agent_runs[\s\S]+approval_request_id\s+UUID/i.test(initSql),
);
check(
  'init.sql **不**对 agent_runs.approval_request_id 建立任何 FK / 索引',
  !/REFERENCES\s+tool_approval_requests/i.test(initSql) ||
    // 若有 REFERENCES，仅允许 tool_approval_requests.run_id →
    // agent_runs.id 的方向（不算反向引用）。校验反向：
    !/agent_runs[\s\S]+REFERENCES\s+tool_approval_requests/i.test(initSql),
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
