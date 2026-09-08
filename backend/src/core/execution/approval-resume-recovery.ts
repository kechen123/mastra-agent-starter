/**
 * Approval Resume Hard-Crash Recovery —— execution 层 cross-aggregate
 * 编排。
 *
 * 职责边界：
 *   - **本模块**负责跨 `tool_approval_requests` + `agent_runs` +
 *     `messages` + `agent_run_events` 四个聚合的"hard-crash"孤儿现场
 *     恢复编排（事务原子写入、按 Tool 元数据 + approval 状态分流、
 *     Run 终态收尾）。
 *   - **tool-policy/repository.ts**仅提供"纯 tool_approval_requests
 *     行级原语"——只接受 PoolClient；不读 Tool 注册表、不写
 *     agent_runs / messages / agent_run_events；不决定 Run 终态。
 *
 * 触发场景（W4）：
 *   - `agent_runs.status='running'` + `lease_expires_at < now()`
 *   - 对应 `tool_approval_requests.status IN ('approved','declined','expired')`
 *   - `tool_approval_requests.mastra_resume_started_at IS NOT NULL`
 *   表示 worker 在 SDK 调用前 / 中 / 终态落库前**直接死亡**（Node
 *   进程被 SIGKILL / OOM，JavaScript catch 不会执行）。普通的
 *   `sweepExpiredLeases` 会把这种孤儿 Run 错误写成
 *   `failed + LEASE_EXPIRED`，留下"approved + started_at NOT NULL +
 *   failed LEASE_EXPIRED"不可恢复的孤儿组合。本模块提供分流恢复。
 *
 * 不变量：
 *   - 多 sweeper 并发：每个候选行 `SELECT ... FOR UPDATE SKIP LOCKED`
 *     抢占——同一行不会被两个 sweeper 同时回收。
 *   - 单 sweeper 内部：所有 SQL 走同一事务——approval / Run /
 *     messages / agent_run_events 要么全部成功要么全部回滚；不会出现
 *     "approval 已改 + Run 未改"的脑裂状态。
 *   - 普通 queued / running Run（无 approval 上下文）走既有
 *     `sweepExpiredLeases`——本模块**不**触碰。
 *   - 本模块在普通 `sweepExpiredLeases` **之前**运行，由
 *     `run-executor.ts::sweepOnce` 保证顺序。
 *
 * 普通 lease sweeper 必须**从 SQL 排除** approval-resume Run（见
 * `runs/repository.ts::sweepExpiredLeases` 的 `NOT EXISTS` 子句）——
 * 不能依赖调用顺序，否则跨实例并发场景下两个 sweeper 仍可能产生孤儿。
 */
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getToolDefinition } from '../tool/registry.js';
import {
  insertRunEvent,
} from '../../modules/runs/repository.js';
import type {
  ApprovalRequestRow,
  ApprovalStatus,
} from '../../modules/tool-policy/types.js';

/**
 * Hard-crash sweeper 一次扫描的统计结果。
 *
 * - `scanned`：候选行扫描数（含被 SKIP LOCKED 跳过的）
 * - `reclaimed`：进入 `approved_resume_indeterminate` + Run → `waiting_approval` 的行数
 * - `manualIntervention`：直接人工介入 + Run → `failed` 的行数（含非幂等 / attempts 耗尽）
 * - `hardCrashFailClosed`：declined / expired 走 fail-closed 路径的行数
 * - `skipped`：扫描与写之间 Run 状态已变化的行数
 */
export interface SweepApprovalResumeResult {
  scanned: number;
  reclaimed: number;
  manualIntervention: number;
  hardCrashFailClosed: number;
  skipped: number;
}

export interface SweepApprovalResumeOptions {
  /** 幂等分支下 lease_expires_at 设置的 backoff（ms）。默认 30_000。 */
  backoffMs?: number;
  /** 达到此 attempts 阈值时不再走 idempotent 重放（默认 3）。 */
  maxAttempts?: number;
}

type ReclaimOutcome =
  | 'reclaimed'
  | 'manual_intervention'
  | 'hard_crash_fail_closed'
  | 'skipped';

interface ReclaimOneInput {
  workspaceId: string;
  approvalId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  approvalStatus: ApprovalStatus;
  currentResumeAttempts: number;
  /** 之前若 resolver_error 已记录 decline 原因，保留供 audit 字段。 */
  priorResolverError: string | null;
  backoffMs: number;
  maxAttempts: number;
}

/**
 * Hard-Crash Sweeper 入口。识别并恢复"进程在 SDK 调用前 / 中 / 终态
 * 落库前死亡"的孤儿现场。**仅**在 sweeper 路径调用；worker 调度器不
 * 调用。
 */
export async function sweepExpiredApprovalResumeLeases(
  options: SweepApprovalResumeOptions = {},
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<SweepApprovalResumeResult> {
  const backoffMs = options.backoffMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const isPoolClient = !('connect' in executor);
  const client: PoolClient = isPoolClient
    ? (executor as PoolClient)
    : await (executor as Pool).connect();
  const callerOwnedTx = isPoolClient;
  const result: SweepApprovalResumeResult = {
    scanned: 0,
    reclaimed: 0,
    manualIntervention: 0,
    hardCrashFailClosed: 0,
    skipped: 0,
  };
  try {
    if (!callerOwnedTx) {
      await client.query('BEGIN');
    }
    // 1) 扫描候选行 + 行级抢占。FOR UPDATE SKIP LOCKED 让并发 sweeper
    //    各自拿到不同子集——避免同一 Run 被回收两次。
    //    锁住的是 tool_approval_requests 行；agent_runs 行由后续
    //    `WHERE id=$1 AND status='running' AND lease_expires_at < now()`
    //    条件 UPDATE 兜底双飞。
    const candidates = await client.query<{
      approval_id: string;
      workspace_id: string;
      run_id: string;
      tool_id: string;
      tool_call_id: string;
      status: ApprovalStatus;
      resume_attempts: number;
      resolver_error: string | null;
    }>(
      `SELECT a.id AS approval_id,
              a.workspace_id,
              a.run_id,
              a.tool_id,
              a.tool_call_id,
              a.status,
              a.resume_attempts,
              a.resolver_error
         FROM tool_approval_requests a
         JOIN agent_runs r
           ON r.id = a.run_id AND r.workspace_id = a.workspace_id
        WHERE a.status IN ('approved', 'declined', 'expired')
          AND a.mastra_resume_started_at IS NOT NULL
          AND r.status = 'running'
          AND r.lease_expires_at IS NOT NULL
          AND r.lease_expires_at < now()
        FOR UPDATE OF a SKIP LOCKED`,
    );
    result.scanned = candidates.rows.length;
    for (const row of candidates.rows) {
      const reclaimed = await reclaimOneApprovalResume(client, {
        workspaceId: row.workspace_id,
        approvalId: row.approval_id,
        runId: row.run_id,
        toolId: row.tool_id,
        toolCallId: row.tool_call_id,
        approvalStatus: row.status,
        currentResumeAttempts: row.resume_attempts,
        priorResolverError: row.resolver_error,
        backoffMs,
        maxAttempts,
      });
      switch (reclaimed) {
        case 'reclaimed': result.reclaimed += 1; break;
        case 'manual_intervention': result.manualIntervention += 1; break;
        case 'hard_crash_fail_closed': result.hardCrashFailClosed += 1; break;
        case 'skipped': result.skipped += 1; break;
      }
    }
    if (!callerOwnedTx) {
      await client.query('COMMIT');
    }
    return result;
  } catch (err) {
    if (!callerOwnedTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (!callerOwnedTx) {
      client.release();
    }
  }
}

async function reclaimOneApprovalResume(
  client: PoolClient,
  input: ReclaimOneInput,
): Promise<ReclaimOutcome> {
  // 二次断言：Run 仍处于 running + lease 仍过期（防止扫描与本行
  // 操作之间 Run 已被别的 sweeper / worker 推回终态）。
  const r = await client.query<{ status: string }>(
    `SELECT status FROM agent_runs
      WHERE id = $1 AND workspace_id = $2
        AND status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
      FOR UPDATE`,
    [input.runId, input.workspaceId],
  );
  if (r.rowCount === 0) return 'skipped';

  // ───── 分支 1：declined / expired 进程丢失 → 走 fail-closed ─────
  // 业务语义：用户已拒绝 / 已超时；hard-crash 不应被"自动重放"。但
  // **不能**留下普通的 LEASE_EXPIRED——必须明确错误码 + 人工可识别。
  if (input.approvalStatus === 'declined' || input.approvalStatus === 'expired') {
    const errCode = input.approvalStatus === 'declined'
      ? 'APPROVAL_RESUME_HARD_CRASH_FAIL_CLOSED_DECLINED'
      : 'APPROVAL_RESUME_HARD_CRASH_FAIL_CLOSED_EXPIRED';
    const resolverError = `APPROVAL_RESUME_HARD_CRASH_FAIL_CLOSED: approval.status=${input.approvalStatus}; `
      + `worker died between SDK call and terminal write; manual review required`;
    // approval：保留原 status（declined/expired）+ 写进程丢失诊断
    await client.query(
      `UPDATE tool_approval_requests
          SET resolver_error = $3,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = $4`,
      [input.approvalId, input.workspaceId, resolverError, input.approvalStatus],
    );
    // Run → failed + 明确错误码 + 清 lease
    const updated = await client.query(
      `UPDATE agent_runs
          SET status           = 'failed',
              error_code       = $3,
              completed_at     = now(),
              lease_owner      = NULL,
              lease_expires_at = NULL,
              heartbeat_at     = NULL,
              updated_at       = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = 'running'`,
      [input.runId, input.workspaceId, errCode],
    );
    if (updated.rowCount === 0) return 'skipped';
    // 消息侧收敛
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF($3, ''),
                       'Run was reclaimed: ' || $4 || '. ' ||
                       '原决策状态 ' || $5 || '；进程丢失后无自动重放。'),
              citations = '[]'::jsonb,
              status    = 'failed'
        WHERE id = (
          SELECT assistant_message_id FROM agent_runs
           WHERE id = $1 AND workspace_id = $2
        )
          AND workspace_id = $2`,
      [input.runId, input.workspaceId, '', errCode, input.approvalStatus],
    );
    await insertRunEvent(client, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: 'run-failed',
      payload: {
        approvalId: input.approvalId,
        toolId: input.toolId,
        toolCallId: input.toolCallId,
        errorCode: errCode,
        reason: resolverError,
        hardCrash: true,
        priorResolverError: input.priorResolverError,
      },
    });
    return 'hard_crash_fail_closed';
  }

  // ───── 分支 2：approved 进程丢失 → 幂等 Tool 走重放，否则人工介入 ─────
  // Tool 元数据校验：必须注册 + idempotent=true。
  const toolDef = getToolDefinition(input.toolId);
  const isIdempotent = toolDef?.metadata.idempotent === true;
  if (!isIdempotent) {
    const resolverError = 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: '
      + `tool ${input.toolId} is not registered as idempotent; `
      + 'hard-crash reclaim refused automatic replay';
    // approval：转 indeterminate + 写人工介入错误
    await client.query(
      `UPDATE tool_approval_requests
          SET status          = 'approved_resume_indeterminate',
              resume_attempts = resume_attempts + 1,
              resolver_error  = $3,
              lease_owner     = NULL,
              lease_expires_at = now() + ($4::int * INTERVAL '1 millisecond'),
              updated_at      = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = 'approved'`,
      [input.approvalId, input.workspaceId, resolverError, input.backoffMs],
    );
    // Run → failed + 明确错误码 + 清 lease
    await client.query(
      `UPDATE agent_runs
          SET status           = 'failed',
              error_code       = 'APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED',
              completed_at     = now(),
              lease_owner      = NULL,
              lease_expires_at = NULL,
              heartbeat_at     = NULL,
              updated_at       = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = 'running'`,
      [input.runId, input.workspaceId],
    );
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF($3, ''),
                       'Run was reclaimed: hard-crash with non-idempotent tool requires manual intervention.'),
              citations = '[]'::jsonb,
              status    = 'failed'
        WHERE id = (
          SELECT assistant_message_id FROM agent_runs
           WHERE id = $1 AND workspace_id = $2
        )
          AND workspace_id = $2`,
      [input.runId, input.workspaceId, ''],
    );
    await insertRunEvent(client, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: 'run-failed',
      payload: {
        approvalId: input.approvalId,
        toolId: input.toolId,
        toolCallId: input.toolCallId,
        errorCode: 'APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED',
        reason: resolverError,
        hardCrash: true,
        priorResolverError: input.priorResolverError,
      },
    });
    return 'manual_intervention';
  }

  // ───── 分支 3：approved + 幂等 Tool + attempts 未耗尽 → 重放 ─────
  if (input.currentResumeAttempts + 1 >= input.maxAttempts) {
    // attempts 耗尽：不再走重放；直接人工介入。
    const resolverError = 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: '
      + `resume_attempts=${input.currentResumeAttempts + 1} >= MAX=${input.maxAttempts}; `
      + 'reached by hard-crash sweeper';
    await client.query(
      `UPDATE tool_approval_requests
          SET status          = 'approved_resume_indeterminate',
              resume_attempts = resume_attempts + 1,
              resolver_error  = $3,
              lease_owner     = NULL,
              lease_expires_at = now() + ($4::int * INTERVAL '1 millisecond'),
              updated_at      = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = 'approved'`,
      [input.approvalId, input.workspaceId, resolverError, input.backoffMs],
    );
    await client.query(
      `UPDATE agent_runs
          SET status           = 'failed',
              error_code       = 'APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED',
              completed_at     = now(),
              lease_owner      = NULL,
              lease_expires_at = NULL,
              heartbeat_at     = NULL,
              updated_at       = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status = 'running'`,
      [input.runId, input.workspaceId],
    );
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF($3, ''),
                       'Run was reclaimed: resume attempts exhausted by hard-crash sweeper.'),
              citations = '[]'::jsonb,
              status    = 'failed'
        WHERE id = (
          SELECT assistant_message_id FROM agent_runs
           WHERE id = $1 AND workspace_id = $2
        )
          AND workspace_id = $2`,
      [input.runId, input.workspaceId, ''],
    );
    await insertRunEvent(client, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: 'run-failed',
      payload: {
        approvalId: input.approvalId,
        toolId: input.toolId,
        toolCallId: input.toolCallId,
        errorCode: 'APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED',
        reason: resolverError,
        hardCrash: true,
        resumeAttempts: input.currentResumeAttempts + 1,
        priorResolverError: input.priorResolverError,
      },
    });
    return 'manual_intervention';
  }

  // ───── 真正的重放分支：approval → indeterminate + Run → waiting_approval ─────
  const reclaimResolverError = 'APPROVAL_RESUME_RECLAIMED_AFTER_HARD_CRASH: '
    + 'worker died between resume claim and terminal write; '
    + `tool=${input.toolId} is idempotent; resume_attempts=${input.currentResumeAttempts + 1}`;
  await client.query(
    `UPDATE tool_approval_requests
        SET status          = 'approved_resume_indeterminate',
            resume_attempts = resume_attempts + 1,
            resolver_error  = $3,
            lease_owner     = NULL,
            lease_expires_at = now() + ($4::int * INTERVAL '1 millisecond'),
            updated_at      = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'approved'`,
    [input.approvalId, input.workspaceId, reclaimResolverError, input.backoffMs],
  );
  await client.query(
    `UPDATE agent_runs
        SET status           = 'waiting_approval',
            lease_owner      = NULL,
            lease_expires_at = NULL,
            heartbeat_at     = NULL,
            completed_at     = NULL,
            error_code       = NULL,
            updated_at       = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'running'`,
    [input.runId, input.workspaceId],
  );
  await insertRunEvent(client, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    type: 'run-resume-reclaimed',
    payload: {
      approvalId: input.approvalId,
      toolId: input.toolId,
      toolCallId: input.toolCallId,
      reason: reclaimResolverError,
      resumeAttempts: input.currentResumeAttempts + 1,
      priorResolverError: input.priorResolverError,
    },
  });
  return 'reclaimed';
}

/**
 * 仅暴露给 module internal 调用：把 approval 行还原成普通 TS 对象。
 * 不暴露在模块外——execution 层只在事务上下文内调用 DB primitives。
 */
export type { ApprovalRequestRow };
