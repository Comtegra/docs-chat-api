// @ts-check
// Cykl życia importu indeksu (plan wielodostępu §3.2): utwórz → partie chunków → aktywuj (atomowy
// swap) | przerwij; reaktywacja archiwalnego importu = ROLLBACK; przycinanie starych importów.
//
// Dlaczego kroki: serwis przyjmuje cały korpus jednym POST (202) i sam pracuje partiami w tle
// (lib/server/app.mjs); osobna aktywacja daje atomowy swap, rollback do archiwalnego importu
// i guard „nie aktywuj kadłubowego indeksu" (minDocumentsRatio).
//
// Stany document_imports.status (CHECK w 001_pgvector_documents.sql):
//   pending  → przyjmuje chunki; activate → active; abort → failed; > 24 h bez aktywacji → failed (prune)
//   active   → dokładnie jeden per (collection_name, language)
//   archived → poprzednie aktywne; activate = rollback; prune zostawia ostatnie N
//   failed   → prune kasuje po 7 dniach

import { createEmbeddings as createEmbeddingsWithOpenAI } from "../embeddings.mjs";
import { getPool, toVectorLiteral, withTransaction } from "../postgres.mjs";
import { getEmbeddingConfig } from "../embeddings.mjs";
import { normalizeLanguage } from "./language.mjs";

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number|null }> }} QueryPool */
/** @typedef {{ title: string, text: string, file_path: string|null, metadata: Record<string, unknown> }} ImportDocument */
/** @typedef {{ id: string, collection_name: string, language: string, status: "pending"|"active"|"archived"|"failed", total_documents: number, commit_sha: string|null, source: string|null, embedding_model?: string|null, activated_at: Date|string|null, created_at: Date|string|null, error: string|null }} ImportRow */

const DEFAULT_EMBEDDING_BATCH = 16;
const DEFAULT_MIN_DOCUMENTS_RATIO = 0.7;

/** Błąd stanu importu (404 nie istnieje / 409 zły stan) — serwer mapuje `status` na HTTP. */
export class ImportStateError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 409) {
    super(message);
    this.name = "ImportStateError";
    this.status = status;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 */
function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

/**
 * Walidacja listy dokumentów/chunków (wspólna dla legacy payloadu i partii).
 * @param {unknown} data
 * @returns {ImportDocument[]}
 */
export function validateImportDocuments(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("data must be a non-empty array");
  }
  return data.map((document, index) => {
    if (!isPlainObject(document)) {
      throw new Error(`data[${index}] must be an object`);
    }
    return {
      title: requiredString(document.title, `data[${index}].title`),
      text: requiredString(document.text, `data[${index}].text`),
      file_path:
        typeof document.file_path === "string" && document.file_path.trim()
          ? document.file_path.trim()
          : null,
      metadata: isPlainObject(document.metadata) ? document.metadata : {},
    };
  });
}

/**
 * @param {ImportDocument[]} documents
 * @param {(inputs: string[]) => Promise<number[][]>} createEmbeddings
 * @param {number} batchSize
 */
async function createEmbeddingsInBatches(documents, createEmbeddings, batchSize) {
  /** @type {number[][]} */
  const embeddings = [];
  for (let index = 0; index < documents.length; index += batchSize) {
    const batch = documents.slice(index, index + batchSize);
    embeddings.push(...(await createEmbeddings(batch.map((document) => document.text))));
  }
  if (embeddings.length !== documents.length) {
    throw new Error(`Embedding count mismatch: ${embeddings.length} for ${documents.length} documents`);
  }
  return embeddings;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} importId
 * @param {{ pool?: QueryPool }} [options]
 * @returns {Promise<ImportRow|null>}
 */
export async function getImport(importId, options = {}) {
  const pool = options.pool || getPool();
  // kolumna id jest uuid: wartość spoza formatu (literalne "undefined" z workflow, ręczny curl)
  // dawałaby pg 22P02 → 500; nieistniejący import to 404, więc odpowiadamy null bez pytania bazy
  const normalizedId = typeof importId === "string" ? importId.trim() : "";
  if (!UUID.test(normalizedId)) {
    return null;
  }
  const result = await pool.query(
    `
      SELECT id, collection_name, language, status, total_documents, commit_sha, source, embedding_model,
             activated_at, created_at, error
      FROM document_imports
      WHERE id = $1
    `,
    [normalizedId]
  );
  return result.rows[0] ?? null;
}

/**
 * Nowy import w stanie `pending` (0 chunków).
 * @param {{ collectionName: string, language: string, source?: string|null, commitSha?: string|null }} input
 * @param {{ pool?: QueryPool }} [options]
 * @returns {Promise<{ importId: string, collectionName: string, language: "EN"|"PL" }>}
 */
export async function createImport(input, options = {}) {
  const pool = options.pool || getPool();
  const collectionName = requiredString(input.collectionName, "collectionName");
  const language = normalizeLanguage(input.language);
  const insertPending = () =>
    pool.query(
      `
        INSERT INTO document_imports (collection_name, language, source, commit_sha, status, total_documents, embedding_model)
        VALUES ($1, $2, $3, $4, 'pending', 0, $5)
        RETURNING id
      `,
      [
        collectionName,
        language,
        typeof input.source === "string" && input.source.trim() ? input.source.trim() : null,
        typeof input.commitSha === "string" && input.commitSha.trim() ? input.commitSha.trim() : null,
        getEmbeddingConfig().model, // stempel: którym modelem policzony będzie ten indeks
      ]
    );
  // 003_one_pending_import: jeden `pending` per (kolekcja, język) — transakcyjny strażnik
  // równoległych importów (guard w pamięci jest per pod i wyścigowy przy 2 replikach).
  // Sprawdzamy NAZWĘ ograniczenia (gdy sterownik ją poda): inne 23505 ma propagować jako 500.
  const isOnePendingConflict = (/** @type {unknown} */ error) => {
    const pgError = /** @type {{ code?: string, constraint?: string }} */ (error);
    return pgError?.code === "23505" && (pgError.constraint === "document_imports_one_pending_idx" || pgError.constraint === undefined);
  };
  let result;
  try {
    result = await insertPending();
  } catch (error) {
    if (!isOnePendingConflict(error)) {
      throw error;
    }
    // Osierocony `pending` (twardy crash poda w trakcie importu — SIGKILL/OOM omija graceful
    // shutdown) nie może blokować indeksowania do ręcznej interwencji: pending starsze niż 24 h
    // wygaszamy i próbujemy raz jeszcze. Świeży pending → 409 z importId (wiadomo, co abortować).
    // Sprzątanie jest best-effort: błąd zapytań pomocniczych nie zmienia odpowiedzi (409).
    let expiredCount = 0;
    try {
      const expired = await pool.query(
        `
          UPDATE document_imports
          SET status = 'failed', error = 'expired: pending for over 24h (crashed import?)'
          WHERE collection_name = $1 AND language = $2 AND status = 'pending'
            AND created_at < now() - interval '24 hours'
          RETURNING id
        `,
        [collectionName, language]
      );
      expiredCount = expired.rows.length;
    } catch {
      // best-effort
    }
    if (expiredCount > 0) {
      try {
        result = await insertPending();
      } catch (retryError) {
        if (isOnePendingConflict(retryError)) {
          // równoległy import wskoczył w okno po wygaszeniu — zwykły konflikt
          throw new ImportStateError(
            `Another pending import already exists for ${collectionName}/${language}; wait for it to finish or abort it`
          );
        }
        throw retryError;
      }
    } else {
      let pendingId = null;
      try {
        const pending = await pool.query(
          `SELECT id FROM document_imports WHERE collection_name = $1 AND language = $2 AND status = 'pending' LIMIT 1`,
          [collectionName, language]
        );
        pendingId = pending.rows[0]?.id ?? null;
      } catch {
        // best-effort
      }
      throw new ImportStateError(
        `Another pending import already exists for ${collectionName}/${language}${pendingId ? ` (importId: ${pendingId})` : ""}; wait for it to finish or abort it`
      );
    }
  }
  return { importId: String(result.rows[0].id), collectionName, language };
}

/**
 * Blokada doradcza (na czas transakcji) na parę kolekcja/język: serializuje activate, prune
 * i append TEJ SAMEJ kolekcji. Bez niej READ COMMITTED przeplatał dwa równoległe activate
 * (chunki archiwalnego importu zostawały aktywne), prune z rollbackiem (import `active` bez
 * chunków) i append z activate (ostatnia paczka niewidoczna dla wyszukiwania) — odtworzone
 * w przeglądzie przed MR. Klucz: hashtext → int4; kolizja między kolekcjami tylko serializuje.
 * Migracja 005 domyka to indeksem: najwyżej jeden `active` per kolekcja/język.
 * @param {QueryPool} client  klient WEWNĄTRZ transakcji (blokada zwalnia się z COMMIT/ROLLBACK)
 * @param {string} collectionName
 * @param {string} language
 */
async function lockCollection(client, collectionName, language) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${collectionName}/${language}`]);
}

/**
 * Partia chunków do importu `pending`: embeddingi + wstawienie NIEaktywnych wierszy w jednej
 * transakcji; licznik `total_documents` rośnie o wstawione.
 * @param {{ importId: string, documents: unknown }} input
 * @param {{ pool?: QueryPool, createEmbeddings?: (inputs: string[]) => Promise<number[][]>, batchSize?: number }} [options]
 * @returns {Promise<{ importId: string, inserted: number, total: number }>}
 */
export async function appendImportChunks(input, options = {}) {
  const pool = options.pool || getPool();
  const createEmbeddings = options.createEmbeddings || createEmbeddingsWithOpenAI;
  const batchSize = options.batchSize || DEFAULT_EMBEDDING_BATCH;

  const row = await getImport(input.importId, { pool });
  if (!row) {
    throw new ImportStateError("Import not found", 404);
  }
  if (row.status !== "pending") {
    throw new ImportStateError(`Import is ${row.status}; chunks can only be added to a pending import`);
  }
  const documents = validateImportDocuments(input.documents);
  const embeddings = await createEmbeddingsInBatches(documents, createEmbeddings, batchSize);

  // INSERT wielowierszowy zamiast wiersz-po-wierszu (znalezisko przeglądu): 200 chunków to było
  // 200 round-tripów; po 50 wierszy = 400 parametrów na zapytanie (limit pg: 65535)
  const INSERT_ROWS_PER_STATEMENT = 50;
  const total = await withTransaction(async (/** @type {QueryPool} */ client) => {
    await lockCollection(client, row.collection_name, row.language);
    for (let offset = 0; offset < documents.length; offset += INSERT_ROWS_PER_STATEMENT) {
      const slice = documents.slice(offset, offset + INSERT_ROWS_PER_STATEMENT);
      /** @type {unknown[]} */
      const params = [];
      const values = slice
        .map((document, index) => {
          const base = params.length;
          params.push(
            row.id,
            row.collection_name,
            row.language,
            document.title,
            document.text,
            document.file_path,
            JSON.stringify(document.metadata),
            toVectorLiteral(embeddings[offset + index])
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}::vector, false)`;
        })
        .join(", ");
      await client.query(
        `
          INSERT INTO document_chunks (
            import_id, collection_name, language, title, text, file_path, metadata, embedding, is_active
          )
          VALUES ${values}
        `,
        params
      );
    }
    const updated = await client.query(
      `
        UPDATE document_imports
        SET total_documents = total_documents + $2
        WHERE id = $1 AND status = 'pending'
        RETURNING total_documents
      `,
      [row.id, documents.length]
    );
    if (updated.rows.length === 0) {
      throw new ImportStateError("Import is no longer pending");
    }
    return Number(updated.rows[0].total_documents);
  }, /** @type {any} */ (pool));

  return { importId: String(row.id), inserted: documents.length, total };
}

/**
 * Atomowy swap: dezaktywuje dotychczasowy aktywny import kolekcji (→ archived) i aktywuje
 * wskazany. `pending` = nowy indeks, `archived` = ROLLBACK do poprzedniej wersji.
 * Guard (tylko dla pending): odmowa, gdy nowy import ma < minDocumentsRatio × dokumentów
 * poprzedniego aktywnego — ochrona przed pustym/kadłubowym indeksem po błędzie eksportu.
 * @param {{ importId: string, minDocumentsRatio?: number, force?: boolean }} input
 * @param {{ pool?: QueryPool }} [options]
 * @returns {Promise<{ importId: string, status: "active", documents: number, previousImportId: string|null }>}
 */
export async function activateImport(input, options = {}) {
  const pool = options.pool || getPool();
  const row = await getImport(input.importId, { pool });
  if (!row) {
    throw new ImportStateError("Import not found", 404);
  }
  if (row.status === "active") {
    throw new ImportStateError("Import is already active");
  }
  if (row.status === "failed") {
    throw new ImportStateError("A failed import cannot be activated");
  }
  const documents = Number(row.total_documents || 0);
  if (row.status === "pending" && documents === 0) {
    throw new ImportStateError("Import has no chunks");
  }

  const previousResult = await pool.query(
    `
      SELECT id, total_documents
      FROM document_imports
      WHERE collection_name = $1 AND language = $2 AND status = 'active'
      ORDER BY activated_at DESC NULLS LAST
      LIMIT 1
    `,
    [row.collection_name, row.language]
  );
  const previous = previousResult.rows[0] ?? null;
  const ratio = input.minDocumentsRatio ?? DEFAULT_MIN_DOCUMENTS_RATIO;
  if (row.status === "pending" && previous && !input.force) {
    const previousDocuments = Number(previous.total_documents || 0);
    if (previousDocuments > 0 && documents < Math.ceil(previousDocuments * ratio)) {
      throw new ImportStateError(
        `Import has ${documents} chunks but the active index has ${previousDocuments} (below ${Math.round(ratio * 100)}%); refusing to activate without force`
      );
    }
  }

  await withTransaction(async (/** @type {QueryPool} */ client) => {
    await lockCollection(client, row.collection_name, row.language);
    await client.query(
      `
        UPDATE document_chunks
        SET is_active = false
        WHERE collection_name = $1 AND language = $2 AND is_active = true
      `,
      [row.collection_name, row.language]
    );
    await client.query(
      `
        UPDATE document_imports
        SET status = 'archived'
        WHERE collection_name = $1 AND language = $2 AND status = 'active'
      `,
      [row.collection_name, row.language]
    );
    await client.query(`UPDATE document_chunks SET is_active = true WHERE import_id = $1`, [row.id]);
    // guard stanu POD blokadą: sprawdzenia wyżej były poza transakcją — równoległy abort/activate
    // mógł w międzyczasie zmienić status (failed/active), a bezwarunkowy UPDATE by to nadpisał
    const activated = await client.query(
      `
        UPDATE document_imports
        SET status = 'active', activated_at = now(), error = NULL
        WHERE id = $1 AND status IN ('pending', 'archived')
        RETURNING id
      `,
      [row.id]
    );
    if (activated.rows.length === 0) {
      throw new ImportStateError("Import state changed during activation; retry after checking its status");
    }
  }, /** @type {any} */ (pool));

  return {
    importId: String(row.id),
    status: "active",
    documents,
    previousImportId: previous ? String(previous.id) : null,
  };
}

/**
 * Przerwanie importu `pending` (→ failed z powodem). Inne stany: 409.
 * @param {{ importId: string, reason?: string }} input
 * @param {{ pool?: QueryPool }} [options]
 */
export async function abortImport(input, options = {}) {
  const pool = options.pool || getPool();
  const result = await pool.query(
    `
      UPDATE document_imports
      SET status = 'failed', error = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING id
    `,
    [input.importId, input.reason || "Import aborted"]
  );
  if (result.rows.length === 0) {
    const row = await getImport(input.importId, { pool });
    if (!row) {
      throw new ImportStateError("Import not found", 404);
    }
    throw new ImportStateError(`Import is ${row.status}; only a pending import can be aborted`);
  }
  return { importId: input.importId, status: /** @type {const} */ ("failed") };
}

/**
 * Ostatnie importy kolekcji (do rollbacku i statusu).
 * @param {{ collectionName: string, language: string, limit?: number }} input
 * @param {{ pool?: QueryPool }} [options]
 * @returns {Promise<ImportRow[]>}
 */
export async function listImports(input, options = {}) {
  const pool = options.pool || getPool();
  const limit = Math.max(1, Math.min(Number(input.limit || 10), 50));
  const result = await pool.query(
    `
      SELECT id, collection_name, language, status, total_documents, commit_sha, source, embedding_model,
             activated_at, created_at, error
      FROM document_imports
      WHERE collection_name = $1 AND language = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [input.collectionName, normalizeLanguage(input.language), limit]
  );
  return result.rows;
}

/**
 * Sprzątanie: porzucone `pending` → failed; archiwalne poza ostatnimi N i failed starsze niż
 * 7 dni — usunięte razem z chunkami (dotąd tabela rosła o pełny korpus przy każdym imporcie).
 * Nigdy nie dotyka importu `active`.
 * @param {{ collectionName: string, language: string, keepArchived?: number, pendingMaxAgeHours?: number }} input
 * @param {{ pool?: QueryPool }} [options]
 * @returns {Promise<{ expiredPending: number, deletedImports: number }>}
 */
export async function pruneImports(input, options = {}) {
  const pool = options.pool || getPool();
  const language = normalizeLanguage(input.language);
  const keepArchived = Math.max(1, Number(input.keepArchived ?? 3));
  const pendingMaxAgeHours = Math.max(1, Number(input.pendingMaxAgeHours ?? 24));

  // całość w JEDNEJ transakcji pod blokadą kolekcji: wybór „stale" i kasowanie widzą ten sam stan,
  // a rollback (activate archiwalnego) nie wejdzie między nie — wcześniej predykat `status <> 'active'`
  // w DELETE był oceniany na innym snapshocie niż SELECT i import po rollbacku zostawał bez chunków
  return withTransaction(async (/** @type {QueryPool} */ client) => {
    await lockCollection(client, input.collectionName, language);
    const expired = await client.query(
      `
        UPDATE document_imports
        SET status = 'failed', error = 'Import expired without activation'
        WHERE collection_name = $1 AND language = $2 AND status = 'pending'
          AND created_at < now() - ($3::int * interval '1 hour')
        RETURNING id
      `,
      [input.collectionName, language, pendingMaxAgeHours]
    );

    const stale = await client.query(
      `
        SELECT id FROM (
          SELECT id, status,
                 row_number() OVER (PARTITION BY status ORDER BY activated_at DESC NULLS LAST, created_at DESC) AS position,
                 created_at
          FROM document_imports
          WHERE collection_name = $1 AND language = $2 AND status IN ('archived', 'failed')
        ) ranked
        WHERE (status = 'archived' AND position > $3::int)
           OR (status = 'failed' AND created_at < now() - interval '7 days')
      `,
      [input.collectionName, language, keepArchived]
    );
    const staleIds = stale.rows.map((/** @type {any} */ row) => String(row.id));
    if (staleIds.length > 0) {
      // `status <> 'active'` zostaje jako pas i szelki (ta sama transakcja, ale zero kosztu)
      await client.query(
        `DELETE FROM document_chunks WHERE import_id IN (
           SELECT id FROM document_imports WHERE id = ANY($1::uuid[]) AND status <> 'active'
         )`,
        [staleIds]
      );
      await client.query(`DELETE FROM document_imports WHERE id = ANY($1::uuid[]) AND status <> 'active'`, [staleIds]);
    }
    return { expiredPending: expired.rows.length, deletedImports: staleIds.length };
  }, /** @type {any} */ (pool));
}
