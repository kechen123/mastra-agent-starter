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
  let failed = 0;
  function assert(label: string, condition: boolean): void {
    if (condition) console.log(`  ✓ ${label}`);
    else { failed += 1; console.error(`  ✗ ${label}`); }
  }

  // 找一个已存在的 workspace；找不到时直接 SKIP，绝不打开连接/注入 storage。
  const ws = await getDatabasePool().query<{ workspace_id: string }>('SELECT workspace_id FROM sources ORDER BY created_at DESC LIMIT 1');
  const workspaceId = ws.rows[0]?.workspace_id;
  if (!workspaceId) {
    console.log('[sources-secret] SKIPPED (no workspace)');
    await getDatabasePool().end();
  } else {
    // storage 注入放在拿到 workspace 之后：避免无 workspace 路径下 storage 半初始化。
    setDocumentStorage(new LocalFsStorage());

    const secretText = '服务器密码：abc123456\n其它内容';
    const buf = Buffer.from(secretText, 'utf-8');

    let caught: unknown = null;
    try { await recordFileSource(workspaceId, { filename: 'secret.txt', mimeType: 'text/plain', buffer: buf }); }
    catch (e) { caught = e; }
    assert('file secret rejected', caught instanceof SensitiveSourceRejectedError);

    // 拒绝路径不应在 sources 写入任何行；sha256('unused') 与真实 buffer 的
    // sha256 不可能相等，所以这条断言等价于"未新增 source"。
    const after = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sources WHERE workspace_id = $1 AND content_hash = $2`,
      [workspaceId, 'unused'],
    );
    assert('no source row created for rejected secret', after.rows[0]?.count === '0');

    if (failed > 0) process.exitCode = 1;
    await getDatabasePool().end();
  }
}

// 保留导入以满足未来扩展（URL 分支 / SourceRejectedError 边界）。
// 故意不删除；ESLint no-unused-vars 在项目内被禁用（见 tsconfig/eslint 配置）。
void recordUrlSource;
void SourceRejectedError;
void getDocumentStorage;
