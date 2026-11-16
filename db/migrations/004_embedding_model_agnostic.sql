-- Przygotowanie pod zmianę modelu embeddingów (runbook: sekcja "Zmiana modelu embeddingów").
--
-- 1) Kolumna bezwymiarowa: `vector` (bez typmod) przyjmuje dowolny wymiar — stare wiersze
--    (3584, gte-qwen2-7b) zostają nietknięte, nowy import może pisać inny wymiar, a atomic
--    swap aktywuje go w jednej transakcji. Spójności pilnuje aplikacja: assertVectorSize
--    przy insertach i zapytaniach + rzutowanie ::halfvec(N) wyłącznie po aktywnych wierszach
--    jednej kolekcji (wiersze w ramach importu są jednorodne).
-- 2) DROP indeksów ANN z wypalonym halfvec(3584): wyrażenie indeksu wybuchłoby przy INSERCIE
--    wiersza o innym wymiarze. Korpusy dokumentacji są małe (setki chunków na kolekcję),
--    partial index był po is_active — seq scan wystarcza z zapasem. Gdy korpus urośnie:
--    MRL (wymiar <= 4000, limit halfvec HNSW) i odtworzyć indeks pod nowy wymiar.
-- 3) Stempel modelu na imporcie: bez niego zmiana modelu to CICHA korupcja (pytanie embedowane
--    nowym modelem vs aktywny indeks policzony starym — zero błędu, śmieciowe wyniki).
DROP INDEX IF EXISTS document_chunks_embedding_hnsw_idx;
DROP INDEX IF EXISTS document_chunks_embedding_ivfflat_idx;

ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector;

ALTER TABLE document_imports ADD COLUMN IF NOT EXISTS embedding_model text;
