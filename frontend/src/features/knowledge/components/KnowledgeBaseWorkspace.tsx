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

  return <section className="flex-1 min-w-0 min-h-0 overflow-y-auto py-8 max-[760px]:pt-16 px-5 sm:px-8 bg-app-bg app-scroll">
    <div className="w-full max-w-[860px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-5 mb-8">
        <div>
          <h1 className="m-0 text-[24px] leading-tight font-semibold tracking-[-0.03em] text-app-text">
            {selectedKnowledgeBase ? selectedKnowledgeBase.name : '知识库'}
          </h1>
          <p className="mt-2 text-app-muted text-[14px] leading-6">
            {selectedKnowledgeBase
              ? `${selectedKnowledgeBase.documentCount} 个文档 · ${selectedKnowledgeBase.chunkCount ?? 0} 个片段`
              : '从左侧选择或新建一个知识库。'}
          </p>
        </div>
        {selectedKnowledgeBase && (
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <button
              className="inline-flex items-center justify-center min-h-9 px-3 rounded-lg text-[13px] text-app-muted bg-transparent border-0 transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:bg-app-hover"
              onClick={onBack}
            >
              返回列表
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 min-h-9 px-3.5 rounded-lg text-[13px] font-medium text-app-bg bg-app-text border-0 transition-[transform,opacity] duration-150 active:scale-[0.98] hover:opacity-90"
              onClick={() => onEnterChat(selectedKnowledgeBase)}
            >
              <Bot size={15} />进入问答
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 min-h-9 px-3 rounded-lg text-[13px] text-app-muted bg-transparent border-0 transition-colors duration-150 hover:text-app-danger hover:bg-app-danger/10 focus-visible:text-app-danger focus-visible:bg-app-danger/10"
              onClick={() => onDeleteKnowledgeBase(selectedKnowledgeBase.id)}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        )}
      </header>
      {error && (
        <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">
          {error}
        </p>
      )}
      {!selectedKnowledgeBase && (
        <>
          {showCreate && (
            <form
              className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_auto] gap-3 mb-6 p-4 rounded-2xl bg-app-surface"
              onSubmit={(event) => void submitCreate(event)}
            >
              <input
                className="min-w-0 h-11 px-3.5 text-[14px] text-app-text bg-app-bg border border-app-border rounded-xl outline-none focus-visible:border-app-border-strong"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="知识库名称"
                maxLength={120}
                autoFocus
              />
              <input
                className="min-w-0 h-11 px-3.5 text-[14px] text-app-text bg-app-bg border border-app-border rounded-xl outline-none focus-visible:border-app-border-strong"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="描述（可选）"
                maxLength={2000}
              />
              <button
                className="inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-[14px] font-medium text-app-bg bg-app-text border-0 transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
                type="submit"
              >
                创建
              </button>
            </form>
          )}
          <div className="grid place-items-center gap-2.5 py-16 px-6 text-app-muted bg-app-surface-muted rounded-2xl text-center">
            <span className="grid place-items-center w-10 h-10 rounded-full bg-app-bg"><Library size={19} /></span>
            <strong className="text-app-text text-[15px]">还没有知识库</strong>
            <p className="max-w-md m-0 text-[14px] leading-6">创建知识库后，可以上传资料，并让回答基于可追溯的原文内容。</p>
          </div>
        </>
      )}
      {selectedKnowledgeBase && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 mb-4 text-app-text bg-app-surface rounded-2xl">
            <div className="min-w-0">
              <strong className="text-[14px] font-medium">添加资料</strong>
              <p className="mt-1 text-app-muted text-[13px] leading-5">{uploadHint}</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={acceptAttr}
              hidden
              onChange={(event) => onUpload(event.target.files?.[0])}
            />
            <button
              className="inline-flex items-center justify-center gap-2 min-h-9 px-3.5 rounded-lg text-[13px] font-medium text-app-bg bg-app-text border-0 transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
            >
              <Upload size={15} />{isUploading ? '正在入库…' : '上传文档'}
            </button>
          </div>
          <div className="grid gap-2">
            {isLoading ? (
              <p className="py-10 px-7 text-app-muted bg-app-surface-muted rounded-2xl text-center text-[14px]">
                正在加载文档…
              </p>
            ) : documents.length === 0 ? (
              <div className="grid place-items-center gap-2.5 py-16 px-6 text-app-muted bg-app-surface-muted rounded-2xl text-center">
                <span className="grid place-items-center w-10 h-10 rounded-full bg-app-bg"><FileText size={19} /></span>
                <strong className="text-app-text text-[15px]">还没有文档</strong>
                <p className="max-w-md m-0 text-[14px] leading-6">上传资料后，这里会展示解析进度、片段数量和处理结果。</p>
              </div>
            ) : (
              documents.map((document) => (
                <article
                  className="group flex items-center gap-3.5 min-h-16 p-3.5 text-app-text bg-app-surface rounded-xl transition-colors duration-150 hover:bg-app-surface-muted"
                  key={document.id}
                >
                  <span className="grid place-items-center w-9 h-9 shrink-0 rounded-lg bg-app-surface-muted group-hover:bg-app-bg"><FileText size={17} className="text-app-muted" /></span>
                  <div className="grid gap-0.5 min-w-0">
                    <strong className="truncate text-[14px] font-medium">{document.name}</strong>
                    <small className="text-app-muted text-[12.5px]">
                      {formatBytes(document.size)} · {document.chunkCount} 个片段 · {formatStatus(document.status)}
                    </small>
                    {document.errorMessage && (
                      <small className="text-app-danger text-[12.5px]">{document.errorMessage}</small>
                    )}
                  </div>
                  <button
                    className="grid place-items-center ml-auto w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-app-danger hover:bg-app-danger/10 focus-visible:opacity-100 focus-visible:text-app-danger focus-visible:bg-app-danger/10"
                    onClick={() => onDeleteDocument(document.id)}
                    aria-label={`删除 ${document.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              ))
            )}
          </div>
        </>
      )}
    </div>
  </section>;
}
