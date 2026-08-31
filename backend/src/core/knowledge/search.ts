/**
 * 工作区隔离的知识库检索门面（V2.3.6 §5.1）。
 *
 * 把 `modules/knowledge/rag/retriever.ts` 的 `searchKnowledgeBase` 包一层：
 *   1. 先以 `workspace_id` 校验目标 KB 是否属于本工作区 —— 跨工作区访问
 *      一律抛 `CrossWorkspaceAccessError`（→ 404），不暴露 ID 存在性。
 *   2. 通过校验后，把请求委托给底层 retriever；retriever 只关心 `kbId`
 *      本身，不再重复做工作区校验。
 *
 * 这是 Agent 运行时唯一允许触发的 KB 检索入口——`streamAgent` 拿到
 * `workspaceId` 后必须走本函数，不能直接 import retriever（防止上层漏校验）。
 */
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { searchKnowledgeBase as ragSearch } from '../../modules/knowledge/rag/retriever.js';
import { CrossWorkspaceAccessError } from '../../server/error-mapping.js';
import type { Citation } from '../../modules/citations/types.js';

/**
 * 在指定工作区内检索知识库。
 *
 * 行为契约：
 *   - `knowledgeBaseId` 不属于 `workspaceId` → `CrossWorkspaceAccessError`（404）。
 *   - KB 存在但无 chunk → 返 `[]`（与底层 retriever 行为一致）。
 *
 * @param workspaceId       当前会话所属工作区（来自 `authCtx.workspaceId`）。
 * @param knowledgeBaseId   待检索知识库 ID。
 * @param query             用户查询文本。
 * @param topK              返回片段上限（默认 5）。
 */
export async function searchKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
  query: string,
  topK = 5,
): Promise<Citation[]> {
  const pool = getDatabasePool();
  // 校验 KB 属于本 workspace —— 0 行 → CrossWorkspaceAccessError（404）。
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
    [knowledgeBaseId, workspaceId],
  );
  if (r.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }
  return ragSearch(knowledgeBaseId, query, topK);
}
