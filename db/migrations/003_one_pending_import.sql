-- Jeden import `pending` per (kolekcja, język) — transakcyjny strażnik crawla/importu:
-- guard w pamięci procesu (lib/server/app.mjs) jest per pod i wyścigowy przy 2 replikach;
-- ten indeks domyka wyścig na poziomie bazy (drugi INSERT dostaje 23505 → 409).
CREATE UNIQUE INDEX IF NOT EXISTS document_imports_one_pending_idx
  ON document_imports (collection_name, language)
  WHERE status = 'pending';
