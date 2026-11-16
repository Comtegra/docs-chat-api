CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS document_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_name text NOT NULL,
  language text NOT NULL,
  source text,
  commit_sha text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'archived', 'failed')),
  error text,
  total_documents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES document_imports(id),
  collection_name text NOT NULL,
  language text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  file_path text,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(3584) NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(text, '')), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_imports_collection_language_status_idx
  ON document_imports (collection_name, language, status);

CREATE INDEX IF NOT EXISTS document_chunks_active_idx
  ON document_chunks (collection_name, language, is_active);

CREATE INDEX IF NOT EXISTS document_chunks_import_idx
  ON document_chunks (import_id);

CREATE INDEX IF NOT EXISTS document_chunks_file_path_idx
  ON document_chunks (file_path);

CREATE INDEX IF NOT EXISTS document_chunks_search_vector_idx
  ON document_chunks USING gin (search_vector);

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
    ON document_chunks
    USING hnsw ((embedding::halfvec(3584)) halfvec_cosine_ops)
    WHERE is_active = true;
EXCEPTION
  WHEN undefined_object OR feature_not_supported OR program_limit_exceeded THEN
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_ivfflat_idx
      ON document_chunks
      USING ivfflat ((embedding::halfvec(3584)) halfvec_cosine_ops)
      WITH (lists = 100)
      WHERE is_active = true;
END $$;
