import { useRef, useState } from 'react';
import { Bot, FileText, Library, Trash2, Upload } from 'lucide-react';
import type { Capabilities, KnowledgeBase, KnowledgeDocument } from '../../../lib/api';

export interface KnowledgeBaseWorkspaceProps {
  selectedKnowledgeBase: KnowledgeBase | null;
  documents: KnowledgeDocument[];
  isLoading: boolean;
  isUploading: boolean;
  showCreate: boolean;
  error: string | null;
  capabilities: Capabilities;
  onCreate: (name: string, description: string) => Promise<void>;
  onBack: () => void;
  onEnterChat: (knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) => void;
  onUpload: (file: File | undefined) => void;
  onDeleteDocument: (id: string) => void;
  onDeleteKnowledgeBase: (id: string) => void;
}

const STATUS_LABEL: Record<KnowledgeDocument['status'], string> = {
  uploaded: '已上传',
  parsing: '解析中',
  chunking: '切分中',
  embedding: '向量生成中',
  completed: '已完成',
  failed: '处理失败',
};

const ACCEPT_MAP: Record<string, string> = {
  txt: '.txt,text/plain',
  md: '.md,text/markdown',
  pdf: '.pdf,application/pdf',
  docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const FORMAT_DISPLAY: Record<string, string> = {
  txt: 'TXT',
  md: 'Markdown',
  pdf: 'PDF',
  docx: 'DOCX',
};

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}

function formatStatus(status: KnowledgeDocument['status']): string {
  return STATUS_LABEL[status];
}

/**
 * 知识库主面板：列表 + 详情 / 创建 / 上传 / 文档删除 / 进入问答。
 *
 * 状态由 App 注入：本组件只消费 props，不直接访问 SSE、Database 或 KnowledgeBase API。
 */
export function KnowledgeBaseWorkspace({
  selectedKnowledgeBase,
  documents,
  isLoading,
  isUploading,
  showCreate,
  error,
  capabilities,
  onCreate,
  onBack,
  onEnterChat,
  onUpload,
  onDeleteDocument,
  onDeleteKnowledgeBase,
}: KnowledgeBaseWorkspaceProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim()) {
      await onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
    }
  }

  const supportedLabels = capabilities.documentFormats.map((f) => FORMAT_DISPLAY[f] ?? f.toUpperCase());
  const acceptAttr = capabilities.documentFormats.map((f) => ACCEPT_MAP[f]).filter(Boolean).join(',');
  const uploadHint = supportedLabels.length > 0 ? `支持 ${supportedLabels.join('、')}，单文件不超过 10 MB。` : '暂不支持文件上传。';

  return <section className="flex-1 min-w-0 min-h-0 overflow-y-auto py-8 px-7 bg-app-bg">
    <div className="w-full max-w-[920px] mx-auto">
      <header className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="m-0 text-2xl">{selectedKnowledgeBase ? selectedKnowledgeBase.name : '知识库'}</h1>
          <p className="mt-2 text-app-muted text-sm">{selectedKnowledgeBase ? `${selectedKnowledgeBase.documentCount} 个文档 · ${selectedKnowledgeBase.chunkCount ?? 0} 个片段` : '从左侧选择或新建一个知识库。'}</p>
        </div>
        {selectedKnowledgeBase && (
          <div className="flex gap-2">
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-text bg-transparent border border-app-border-strong focus-visible:outline-none focus-visible:border-focus-border" onClick={onBack}>返回列表</button>
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text focus-visible:outline-none focus-visible:opacity-90" onClick={() => onEnterChat(selectedKnowledgeBase)}><Bot size={17} />进入问答</button>
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-danger bg-transparent border border-app-danger/50 focus-visible:outline-none focus-visible:border-focus-border" onClick={() => onDeleteKnowledgeBase(selectedKnowledgeBase.id)}><Trash2 size={16} />删除</button>
          </div>
        )}
      </header>
      {error && <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">{error}</p>}
      {!selectedKnowledgeBase && (
        <>
          {showCreate && (
            <form className="grid grid-cols-[1fr_1.5fr_auto] gap-2.5 mb-5" onSubmit={(event) => void submitCreate(event)}>
              <input className="min-w-0 py-2.5 px-2.5 text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0" value={name} onChange={(event) => setName(event.target.value)} placeholder="知识库名称" maxLength={120} autoFocus />
              <input className="min-w-0 py-2.5 px-2.5 text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述（可选）" maxLength={2000} />
              <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:opacity-90" type="submit">创建</button>
            </form>
          )}
          <div className="grid place-items-center gap-2 py-9 px-6 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">
            <Library size={24} />
            <strong className="text-app-text">还没有知识库</strong>
            <p className="max-w-md m-0 leading-relaxed">创建知识库后，可以上传 TXT 或 Markdown，并让知识库问答基于资料回答。</p>
          </div>
        </>
      )}
      {selectedKnowledgeBase && (
        <>
          <div className="flex items-center justify-between p-4 mb-4 text-app-text bg-app-surface border border-app-border rounded-xl">
            <div>
              <strong>上传文本资料</strong>
              <p className="mt-2 text-app-muted text-sm">{uploadHint}</p>
            </div>
            <input ref={inputRef} type="file" accept={acceptAttr} hidden onChange={(event) => onUpload(event.target.files?.[0])} />
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:opacity-90" onClick={() => inputRef.current?.click()} disabled={isUploading}><Upload size={17} />{isUploading ? '正在入库…' : '上传文档'}</button>
          </div>
          <div className="grid gap-2.5">
            {isLoading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在加载文档…</p>
              : documents.length === 0 ? (
                <div className="grid place-items-center gap-2 py-9 px-6 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">
                  <FileText size={24} />
                  <strong className="text-app-text">还没有文档</strong>
                  <p className="max-w-md m-0 leading-relaxed">支持 TXT、Markdown；上传后会显示处理状态。</p>
                </div>
              ) : documents.map((document) => (
                <article className="flex items-center gap-3.5 p-4 text-app-text bg-app-surface border border-app-border rounded-xl" key={document.id}>
                  <FileText size={21} />
                  <div className="grid gap-1 min-w-0">
                    <strong className="truncate">{document.name}</strong>
                    <small className="text-app-muted text-xs">{formatBytes(document.size)} · {document.chunkCount} 个片段 · {formatStatus(document.status)}</small>
                    {document.errorMessage && <small className="text-app-danger">{document.errorMessage}</small>}
                  </div>
                  <button className="grid place-items-center ml-auto p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover focus-visible:outline-none focus-visible:text-app-text focus-visible:bg-app-hover" onClick={() => onDeleteDocument(document.id)} aria-label={`删除 ${document.name}`}><Trash2 size={17} /></button>
                </article>
              ))}
          </div>
        </>
      )}
    </div>
  </section>;
}
