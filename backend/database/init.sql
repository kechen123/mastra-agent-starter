CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  author TEXT,
  dynasty TEXT,
  category TEXT NOT NULL,
  version TEXT,
  type TEXT NOT NULL CHECK (type IN ('scripture', 'commentary', 'historical', 'research')),
  original_work TEXT,
  commentator TEXT,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS works_identity_idx
  ON works (title, COALESCE(version, ''), type, COALESCE(commentator, ''));

CREATE TABLE IF NOT EXISTS chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id UUID NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ordinal INTEGER,
  original_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE INDEX IF NOT EXISTS chapters_work_id_idx ON chapters(work_id);

-- 通用知识库底层。现有 works / chapters 仍服务于典籍 Demo，不迁移也不依赖本组表。
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  type TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'parsing', 'chunking', 'embedding', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_knowledge_base_id_idx ON documents(knowledge_base_id);

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 与当前 EMBEDDING_DIM 默认值和 scriptureVector 的精确检索策略保持一致。
  embedding vector(2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_knowledge_base_id_idx ON document_chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks(document_id);
