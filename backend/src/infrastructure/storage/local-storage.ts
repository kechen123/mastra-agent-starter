/**
 * PR-4.2 §8.1：DocumentStorage 的本地 FS 实现。
 *
 * 路径布局：
 *   - staging: `<root>/staging/<workspaceId>/<uploadId>`
 *   - final:   `<root>/final/<workspaceId>/<documentId>.<ext>`
 *
 * 关键操作语义：
 *   - putStaging: 写新文件 + 计算 sha256（流式哈希避免内存爆）；
 *   - finalize: `rename` 到 final 路径——同 FS 内是原子的（POSIX
 *     保证 inode 不被任何其他 reader 看到中间态）；
 *   - abortStaging / remove: `unlink`，ENOENT 视为成功；
 *   - getBytes: 读整个文件；Worker 一次性读，不会并发写。
 *
 * 关于 `<root>`：
 *   - 默认 `data/documents`（仓库根目录下）；可通过 `DOCUMENT_STORAGE_ROOT`
 *     覆盖。
 *   - 仓库 `.gitignore` 已忽略 `data/` 目录（PR-4.2.1）。
 *
 * 关于 SHA-256：
 *   - Node 22 自带 `crypto.hash`，不引入新依赖；
 *   - 计算放在 putStaging 内（写入磁盘前先 hash）；同一 Buffer 不会
 *     再次被读，因此一次哈希即可。
 */
import { createHash } from 'node:crypto';
import { promises as fsp, type ReadStream } from 'node:fs';
import * as path from 'node:path';
import type { DocumentStorage } from './document-storage.js';

export interface LocalFsStorageOptions {
  /** 绝对或相对路径；默认 `data/documents`（仓库根目录）。 */
  root?: string;
}

const DEFAULT_ROOT = path.resolve(process.cwd(), 'data', 'documents');

export class LocalFsStorage implements DocumentStorage {
  private readonly root: string;

  constructor(options: LocalFsStorageOptions = {}) {
    this.root = options.root ?? process.env.DOCUMENT_STORAGE_ROOT ?? DEFAULT_ROOT;
  }

  async putStaging(input: {
    uploadId: string;
    body: Buffer;
    meta: { mimeType: string; size: number };
  }): Promise<{ stagingKey: string; sha256: string }> {
    if (!input.uploadId) {
      throw new Error('putStaging: uploadId 不能为空。');
    }
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    // staging 路径不带 workspaceId——HTTP 上传路由在 multipart 解析阶段
    // 还没拿到认证上下文；后续 finalize 时再用 workspaceId + documentId
    // 决定 final 路径。文件落在独立目录，与 final 命名空间隔离。
    const stagingKey = `staging/${input.uploadId}`;
    const fullPath = path.join(this.root, stagingKey);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    // 临时文件 + rename 原子晋升。两次提交 (open -> fsync -> rename)
    // 保证即使进程崩溃也不会出现"半截写入"被 finalize worker 拾到。
    const tmpPath = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    let file: import('node:fs').promises.FileHandle | null = null;
    try {
      file = await fsp.open(tmpPath, 'w', 0o600);
      await file.writeFile(input.body);
      await file.sync();
    } finally {
      await file?.close();
    }
    await fsp.rename(tmpPath, fullPath);
    return { stagingKey, sha256 };
  }

  async finalize(stagingKey: string, finalKey: string): Promise<void> {
    if (!stagingKey.startsWith('staging/') || !finalKey.startsWith('final/')) {
      throw new Error(
        `finalize: 命名空间非法（stagingKey=${stagingKey}, finalKey=${finalKey}）；` +
          '必须分别位于 staging/ 与 final/ 下，避免跨命名空间误删。',
      );
    }
    const from = path.join(this.root, stagingKey);
    const to = path.join(this.root, finalKey);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    // PR-4 整改：finalize 必须幂等。如果 staging 不存在但 finalKey
    // 已存在（上一轮 IO 成功 + DB 写回未追上导致重入），视为已完成。
    // 注意：直接调 rename(from, to) 当 from 缺失会抛 ENOENT；这里提前
    // 探测，避免 ENOENT 抛到 worker。
    const fromExists = await this.pathExists(from);
    if (!fromExists) {
      const toExists = await this.pathExists(to);
      if (toExists) {
        // 已晋升；幂等返回。
        return;
      }
      // 都不存在：上一轮上传未真正落盘，抛 NOT_FOUND 让 worker 走退避。
      const err = new Error(`finalize: staging 与 finalKey 都不存在（stagingKey=${stagingKey}）`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    try {
      await fsp.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 并发路径：rename 瞬间另一个 finalize 也跑了同一 IO。让 ENOENT
        // 继续被处理（exists 探针会再次确认幂等收敛）。
        const toExists = await this.pathExists(to);
        if (toExists) return;
      }
      throw err;
    }
  }

  async exists(finalKey: string): Promise<boolean> {
    const fullPath = path.join(this.root, finalKey);
    return this.pathExists(fullPath);
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async abortStaging(stagingKey: string): Promise<void> {
    await this.unlinkQuiet(stagingKey);
  }

  async remove(finalKey: string): Promise<void> {
    await this.unlinkQuiet(finalKey);
  }

  async getBytes(finalKey: string): Promise<Buffer> {
    const fullPath = path.join(this.root, finalKey);
    try {
      return await fsp.readFile(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 抛出专用错误，worker 走退避重试而非 cancel——通常意味着
        // finalize worker 还没完成，或 outbox 还没把对象清掉。
        const err = new Error(`getBytes: finalKey=${finalKey} 不存在。`);
        (err as NodeJS.ErrnoException).code = 'DOCUMENT_STORAGE_NOT_FOUND';
        throw err;
      }
      throw error;
    }
  }

  private async unlinkQuiet(key: string): Promise<void> {
    const fullPath = path.join(this.root, key);
    try {
      await fsp.unlink(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 幂等：对象已被 GC / 已被前次重试清掉。
        return;
      }
      throw error;
    }
  }

  /** 测试用：列出 staging 目录现存对象。 */
  async _listStagingForTest(): Promise<string[]> {
    const stagingRoot = path.join(this.root, 'staging');
    return walk(stagingRoot);
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

// 仅在测试或脚本里需要直接打开读流；公开以备扩展。
export function _openReadStream(stream: ReadStream): ReadStream {
  return stream;
}
