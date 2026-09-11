/**
 * PR-4 整改（2026-09-11 第二轮）：embedding_profiles repository。
 *
 * 唯一职责：
 *   1) 读取当前 workspace 的 active profile；
 *   2) 若不存在，原子地创建一个（并发安全：partial unique
 *      `one_active_embedding_profile_per_workspace` 兜底）。
 *
 * 不变量：
 *   - **只在 RAG 模式下被调用**；Core-only 部署下 RAG 表不存在，
 *     调用方需先通过 `config.ragEnabled` 短路；
 *   - 创建时 provider / model / dimensions **必须**取自明确配置
 *     （config.embeddingProvider / embeddingModel / embeddingDim）；
 *     不允许凭运行时猜测。
 *   - 不持久化跨 workspace 操作（workspaceId 必传且 WHERE 强制）。
 *
 * 并发安全：
 *   - partial unique `one_active_embedding_profile_per_workspace`
 *     保证同一 workspace 同一时刻最多一个 active profile；
 *   - 创建失败（23505）→ 回退到 SELECT；SELECT 必然能找到已存在
 *     的 active 行；这是 PostgreSQL 单语句 atomic upsert 模式。
 */
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import { config } from '../../../config.js';

export interface EmbeddingProfileRow {
  id: string;
  workspaceId: string;
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  status: 'active' | 'inactive' | 'migrating' | 'legacy';
  isActive: boolean;
}

interface RawRow {
  id: string;
  workspace_id: string;
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  status: 'active' | 'inactive' | 'migrating' | 'legacy';
  is_active: boolean;
}

function rowToProfile(row: RawRow): EmbeddingProfileRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    version: row.version,
    status: row.status,
    isActive: row.is_active,
  };
}

/**
 * 获取当前 workspace 的 active profile；若不存在，原子创建一个。
 *
 * 调用方必须已确认 `config.ragEnabled=true`——本函数不重复校验。
 *
 * 行为：
 *   - 已有 active profile → 直接返回（**不**覆盖既有 profile；
 *     切换 provider / model 是上层管理动作）；
 *   - 没有 → 在一个 client + 单事务内：
 *       a) SELECT 一次（无 active 时进入 INSERT）；
 *       b) INSERT profile（is_active=true, status='active'）；
 *       c) 若 INSERT 抛 23505（并发另一 worker 已建）→ 关闭事务、
 *          用 pool 再 SELECT 一次取回对方创建的 active profile。
 *
 * 返回值：保证非 null；调用方拿到 row 即可写入 document_embeddings。
 */
export async function getOrCreateActiveEmbeddingProfile(input: {
  workspaceId: string;
  executor?: Pool | PoolClient;
}): Promise<EmbeddingProfileRow> {
  if (!input.workspaceId) {
    throw new Error('getOrCreateActiveEmbeddingProfile: workspaceId 必填。');
  }
  if (!config.ragEnabled) {
    throw new Error(
      'getOrCreateActiveEmbeddingProfile 不应在 Core-only 模式下调用；' +
        '调用方需先确认 config.ragEnabled=true。',
    );
  }

  const pool = input.executor ?? getDatabasePool();

  // 1) 快速路径：已有 active profile → 直接返回。
  const existing = await pool.query<RawRow>(
    `SELECT id, workspace_id, provider, model, dimensions, version, status, is_active
       FROM embedding_profiles
      WHERE workspace_id = $1 AND is_active = TRUE
      LIMIT 1`,
    [input.workspaceId],
  );
  if (existing.rows.length > 0) {
    return rowToProfile(existing.rows[0]!);
  }

  // 2) 没有 active profile → 原子创建。来源全部取自 config，**禁止**
  //    凭运行时推断。
  const client = (await pool.connect()) as PoolClient;
  try {
    await client.query('BEGIN');
    let inserted: RawRow | null = null;
    try {
      const r = await client.query<RawRow>(
        `INSERT INTO embedding_profiles
           (workspace_id, provider, model, dimensions, version, status, is_active)
         VALUES ($1, $2, $3, $4, 'v1', 'active', TRUE)
         RETURNING id, workspace_id, provider, model, dimensions, version, status, is_active`,
        [
          input.workspaceId,
          config.embeddingProvider,
          config.embeddingModel,
          config.embeddingDim,
        ],
      );
      inserted = r.rows[0] ?? null;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string } | null)?.code;
      if (code !== '23505') throw err;
      // 23505 = unique_violation：partial unique
      // `one_active_embedding_profile_per_workspace` 触发；并发
      // 另一 worker 已建好 active profile。落到下方"重新 SELECT"。
      inserted = null;
    }
    if (inserted) {
      return rowToProfile(inserted);
    }

    // 3) 并发路径：对方刚建好。再 SELECT 一次取回对方插入的 active 行。
    const after = await pool.query<RawRow>(
      `SELECT id, workspace_id, provider, model, dimensions, version, status, is_active
         FROM embedding_profiles
        WHERE workspace_id = $1 AND is_active = TRUE
        LIMIT 1`,
      [input.workspaceId],
    );
    if (after.rows.length === 0) {
      // 极端情况：23505 触发但 active 行已被对方回滚 / 重新失活。
      // 视作"本轮无法收敛"抛错，让上层走正常重试（与 ingestion
      // 失败路径一致：attempts < max 时退避重试）。
      throw new Error(
        'embedding_profiles 并发创建冲突后回退查询失败；请重试 ingestion。',
      );
    }
    return rowToProfile(after.rows[0]!);
  } finally {
    client.release();
  }
}