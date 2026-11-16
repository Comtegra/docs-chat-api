-- Najwyżej JEDEN aktywny import per kolekcja/język — gwarancja na poziomie bazy.
-- Kod serializuje activate/prune/append blokadą doradczą (lib/vdb/imports.mjs lockCollection);
-- indeks łapie każdą inną ścieżkę (ręczny UPDATE, stary kod). Na bazie z danymi (produkcja)
-- sprawdź wcześniej duplikaty — runbook docs/docs-chat-api.md §6.4 (zapytanie kontrolne);
-- przy duplikacie migracja pada głośno i trzeba ręcznie zarchiwizować nadmiarowy import.
CREATE UNIQUE INDEX IF NOT EXISTS document_imports_one_active_idx
  ON document_imports (collection_name, language)
  WHERE status = 'active';
