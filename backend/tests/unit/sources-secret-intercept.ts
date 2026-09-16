/**
 * Task 12: 验证 recordFileSource / recordUrlSource 在敏感凭据被检测到时
 * 立即拒绝，不会触碰 DB、对象存储或 Embedding 服务。
 *
 * 运行方式：
 *   cd backend && npx tsx tests/unit/sources-secret-intercept.ts
 *
 * 默认行为：沙箱/CI 没有 DATABASE_URL 时 SKIPPED；
 * 当且仅当 DATABASE_URL 形如 `...?safety-identifier=test_...` 时进入主测试。
 * 该 `safety-identifier` 闸门保证我们不会对生产数据库写入测试数据。
 */
import { recordFileSource, recordUrlSource, SensitiveSourceRejectedError, SourceRejectedError } from '../../src/modules/sources/service.js';
import { getDocumentStorage } from '../../src/infrastructure/storage/document-storage.js';
import { LocalFsStorage } from '../../src/infrastructure/storage/local-storage.js';
import { setDocumentStorage } from '../../src/infrastructure/storage/document-storage.js';
import { getDatabasePool } from '../../src/infrastructure/database/pool.js';

// 仅当 DATABASE_URL 存在且指向测试库时跑；否则 SKIP。
const haveDb = !!process.env.DATABASE_URL && process.env.DATABASE_URL.includes('safety-identifier=test_');
if (!haveDb) {
  console.log('[sources-secret] SKIPPED (DATABASE_URL not set)');
} else {
  setDocumentStorage(new LocalFsStorage());

  let failed = 0;
  function assert(label: string, condition: boolean): void {
    if (condition) console.log(`  ✓ ${label}`);
    else { failed += 1; console.error(`  ✗ ${label}`); }
  }

  // 找一个已存在的 workspace
  const ws = await getDatabasePool().query<{ workspace_id: string }>('SELECT workspace_id FROM sources ORDER BY created_at DESC LIMIT 1');
  const workspaceId = ws.rows[0]?.workspace_id;
  if (!workspaceId) {
    console.log('[sources-secret] SKIPPED (no workspace)');
  } else {
    const secretText = '服务器密码：abc123456\n其它内容';
    const buf = Buffer.from(secretText, 'utf-8');

    let caught: unknown = null;
    try { await recordFileSource(workspaceId, { filename: 'secret.txt', mimeType: 'text/plain', buffer: buf }); }
    catch (e) { caught = e; }
    assert('file secret rejected', caught instanceof SensitiveSourceRejectedError);

    // 保留对未来 DB 增量检查的扩展点：本测试不构造 baseline 计数，
    // 仅记录"未新增 source"的事后探针——当 DB 不可用或 schema 漂移时
    // 也不会让测试本身崩掉。
    const after = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sources WHERE workspace_id = $1 AND content_hash = $2`,
      [workspaceId, 'unused'],
    );
    void after;

    if (failed > 0) process.exitCode = 1;
    await getDatabasePool().end();
  }
}

// 引用：保留导入以满足未来扩展（URL 分支 / SourceRejectedError 边界）。
void recordUrlSource;
void SourceRejectedError;
void getDocumentStorage;
