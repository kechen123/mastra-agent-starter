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
