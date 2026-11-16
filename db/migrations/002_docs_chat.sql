CREATE TABLE IF NOT EXISTS docs_chat_rate_limits (
  key_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_hash, window_start)
);

CREATE INDEX IF NOT EXISTS docs_chat_rate_limits_window_start_idx
  ON docs_chat_rate_limits (window_start);

CREATE INDEX IF NOT EXISTS document_chunks_metadata_source_file_path_idx
  ON document_chunks ((metadata->>'sourceFilePath'))
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS document_chunks_metadata_route_idx
  ON document_chunks ((metadata->>'route'))
  WHERE is_active = true;
