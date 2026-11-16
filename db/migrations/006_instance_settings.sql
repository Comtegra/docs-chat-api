-- Ustawienia instancji (persist przez recreate compute — baza to osobny zasób).
-- Na start: sha256 klucza importu wygenerowanego przy pierwszym boocie
-- (RAW pokazany raz w logu startu; docs/superpowers/plans/env-config-refactor.md).
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
