/**
 * PR-4.2 §8.1：DocumentStorage 抽象。
 *
 * 设计目标：
 *   1. 上传路径只关心"落到 staging / finalize / 删除"三件事；
 *   2. 具体后端（本地 FS、S3、Azure Blob 等）由 factory 选择；
 *   3. HTTP 路由、ingestion worker、outbox worker 都只依赖接口；
 *   4. `putStaging` 必须返回 sha256，路由层用它做 dedup；
 *   5. `finalize` 是**原子 rename**语义——成功后 finalKey 才能被
 *      ingestion worker 读取；`abortStaging` 与 `remove` 容忍 ENOENT
 *      （outbox 幂等重试会反复触发）。
 *
 * 不变量：
 *   - staging key 与 final key 不在同一命名空间，避免 finalize 竞态
 *     导致 ingestion worker 读到正在被重命名的对象；
 *   - `remove(finalKey)` 与 outbox 联动；删除后再次调用 `remove` 必须
 *     静默成功（幂等）；
 *   - `getBytes` 仅 ingestion worker 在 finalizing 阶段使用；调用方
 *     持有 lease，租约过期后另一 worker 接管，可能需要再次读取。
 */
export interface DocumentStorage {
  /**
   * 把上传字节落到 staging 命名空间；返回 stagingKey 与 sha256。
   *
   * 重要：相同字节重复上传**不应**复用同一 stagingKey（避免 hash
   * 冲突被外部清掉时影响后续上传）。通常 stagingKey 由 `uploadId`
   * 派生，保证唯一性。
   */
  putStaging(input: {
    uploadId: string;
    body: Buffer;
    meta: { mimeType: string; size: number };
  }): Promise<{ stagingKey: string; sha256: string }>;

  /**
   * 把 staging 对象原子地晋升到 final 命名空间。
   *
   * 失败语义：抛出 → finalize worker 走退避重试；本方法**不**自行
   * 清理 staging（让 worker 保留证据以便重试诊断）。
   */
  finalize(stagingKey: string, finalKey: string): Promise<void>;

  /**
   * 主动取消：上传解析失败、用户撤回等。容忍 ENOENT（对象已被 GC）。
   */
  abortStaging(stagingKey: string): Promise<void>;

  /**
   * 删除 final 命名空间的对象。幂等——ENOENT 视为成功。
   *
   * 注意：本方法不修改数据库状态；调用方负责将
   * `storage_deletion_outbox.processed_at = now()` 同步写回。
   */
  remove(finalKey: string): Promise<void>;

  /**
   * ingestion worker 在 finalizing 阶段读取 final 对象做 parse。
   * 文件不存在 → 抛 NOT_FOUND 让 worker 走退避（可能是 finalize
   * worker 还没完成）。
   */
  getBytes(finalKey: string): Promise<Buffer>;

  /**
   * 探测 final 命名空间的对象是否存在。
   *
   * PR-4 整改：finalize worker 在 IO 抛 ENOENT 后需要决定"上一轮已
   * 晋升成功但 DB 写回未追上"还是"上一轮真失败"——通过 exists 探针
   * 完成幂等收敛。本方法不允许抛错（不存在 → false；探测 IO 错 →
   * 也视为 false，由调用方走普通重试）。
   */
  exists(finalKey: string): Promise<boolean>;
}

/**
 * 命名空间路径规则（local FS 实现使用）：
 *   - staging: `<root>/staging/<workspaceId>/<uploadId>`
 *   - final:   `<root>/final/<workspaceId>/<documentId>.<ext>`
 *
 * 把 workspaceId 嵌进路径而非文件名，是为了 O(1) 列出某 workspace
 * 的所有对象（未来的 retention 扫描）。
 */

/**
 * 单例工厂：bootstrap 阶段注入，HTTP 路由 / worker 都通过
 * `getDocumentStorage()` 拿同一份实例，避免多实例多 FS 句柄。
 */
let storageSingleton: DocumentStorage | null = null;

export function setDocumentStorage(instance: DocumentStorage): void {
  storageSingleton = instance;
}

export function getDocumentStorage(): DocumentStorage {
  if (!storageSingleton) {
    throw new Error(
      'DocumentStorage 未注入：请在 bootstrap 阶段调用 setDocumentStorage(...)；' +
        'core 模式下 LocalFSStorage 是默认实现。',
    );
  }
  return storageSingleton;
}

export function _resetDocumentStorageForTesting(): void {
  storageSingleton = null;
}
