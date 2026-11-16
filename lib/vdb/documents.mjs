import { buildRouteCandidates, encodeRouteSegments } from "./route.mjs";

export { buildRouteCandidates, encodeRouteSegments };
import { createQueryEmbedding, getEmbeddingConfig } from "../embeddings.mjs";
import { getPool, toVectorLiteral } from "../postgres.mjs";
import {
  inferLanguageFromCollection,
  normalizeLanguage,
} from "./language.mjs";

const DEFAULT_QUERY_LIMIT = 5;
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_VECTOR_SIZE = 3584;
const RRF_K = 60;
const VECTOR_WEIGHT = 0.3;
const TEXT_WEIGHT = 0.7;
const TEXT_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "about",
  "can",
  "could",
  "for",
  "from",
  "how",
  "in",
  "is",
  "me",
  "of",
  "on",
  "please",
  "show",
  "tell",
  "the",
  "to",
  "what",
  "where",
  "who",
  "with",
  "czy",
  "co",
  "gdzie",
  "jak",
  "jest",
  "kto",
  "mi",
  "na",
  "nie",
  "o",
  "oraz",
  "po",
  "pokaż",
  "proszę",
  "są",
  "to",
  "w",
  "we",
  "z",
  "za",
  "ze",
]);

// Filtr zakresu strony (docs-chat scope=page): po sourceFilePath ($10, klient sprzed E2)
// LUB po metadata.route ($11, permalink z klienta po E2; indeks: 002_docs_chat.sql).
// UWAGA: pierwsza koniunkcja `$10 IS NULL AND $11 IS NULL` = „brak filtra" TYLKO gdy oba
// są puste — bez niej klient wysyłający sam permalink dostawałby całą kolekcję pod etykietą
// „ta strona" (plan §4.2, R3).
function buildPageScopeFilter(columnPrefix = "") {
  return `
          AND (
            ($10::text IS NULL AND $11::text[] IS NULL)
            OR ${columnPrefix}metadata->>'sourceFilePath' = $10
            OR ${columnPrefix}file_path = $10
            OR ${columnPrefix}metadata->>'route' = ANY($11::text[])
          )`;
}

export { normalizeLanguage, inferLanguageFromCollection };


function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

export function buildDocumentObjects(rows) {
  return rows.map((row) => {
    const object = {
      id: row.id,
      properties: {
        title: row.title,
        text: row.text,
        file_path: row.file_path,
        metadata: row.metadata || {},
      },
    };

    if (row.score !== undefined && row.score !== null) {
      object.score = Number(row.score);
    }

    return object;
  });
}

export function buildTextSearchQuery(query) {
  const terms = String(query || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);

  if (!terms) {
    return "";
  }

  return [
    ...new Set(
      terms.filter((term) => term.length > 2 && !TEXT_QUERY_STOPWORDS.has(term))
    ),
  ].join(" | ");
}

export function getHybridQuerySql(vectorSize = DEFAULT_VECTOR_SIZE) {
  const safeVectorSize = Number(vectorSize);

  if (!Number.isInteger(safeVectorSize) || safeVectorSize <= 0) {
    throw new Error("vectorSize must be a positive integer");
  }

  return `
      WITH vector_candidates AS (
        SELECT
          id,
          1 - (embedding::halfvec(${safeVectorSize}) <=> $1::halfvec(${safeVectorSize})) AS vector_score
        FROM document_chunks
        WHERE collection_name = $3
          AND language = $4
          AND is_active = true
          ${buildPageScopeFilter()}
        ORDER BY embedding::halfvec(${safeVectorSize}) <=> $1::halfvec(${safeVectorSize})
        LIMIT $5
      ),
      vector_matches AS (
        SELECT
          id,
          row_number() OVER (ORDER BY vector_score DESC) AS vector_rank,
          vector_score
        FROM vector_candidates
      ),
      text_query AS (
        SELECT
          CASE
            WHEN NULLIF($2, '') IS NULL THEN NULL
            ELSE to_tsquery('simple', $2)
          END AS query
      ),
      text_candidates AS (
        SELECT
          document_chunks.id,
          ts_rank_cd(document_chunks.search_vector, text_query.query) AS text_score
        FROM document_chunks, text_query
        WHERE document_chunks.collection_name = $3
          AND document_chunks.language = $4
          AND document_chunks.is_active = true
          ${buildPageScopeFilter("document_chunks.")}
          AND text_query.query IS NOT NULL
          AND document_chunks.search_vector @@ text_query.query
        ORDER BY text_score DESC
        LIMIT $5
      ),
      text_matches AS (
        SELECT
          id,
          row_number() OVER (ORDER BY text_score DESC) AS text_rank,
          text_score
        FROM text_candidates
      )
      SELECT
        document_chunks.id,
        document_chunks.title,
        document_chunks.text,
        document_chunks.file_path,
        document_chunks.metadata,
        (
          $7::float8 * COALESCE(1.0 / ($8::float8 + vector_matches.vector_rank), 0) +
          $9::float8 * COALESCE(1.0 / ($8::float8 + text_matches.text_rank), 0)
        ) AS score,
        vector_matches.vector_score,
        text_matches.text_score
      FROM document_chunks
      LEFT JOIN vector_matches ON vector_matches.id = document_chunks.id
      LEFT JOIN text_matches ON text_matches.id = document_chunks.id
      WHERE document_chunks.collection_name = $3
        AND document_chunks.language = $4
        AND document_chunks.is_active = true
        ${buildPageScopeFilter("document_chunks.")}
        AND (vector_matches.id IS NOT NULL OR text_matches.id IS NOT NULL)
      ORDER BY score DESC, vector_matches.vector_score DESC NULLS LAST
      LIMIT $6
    `;
}

/**
 * Waga w fuzji RRF: liczba z [0, 1]; poza zakresem / nie-liczba → fallback (domyślne wagi CGC).
 * @param {unknown} value
 * @param {number} fallback
 */
function fusionWeight(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

/**
 * Wyszukiwanie hybrydowe w JEDNEJ kolekcji. `input.collectionName` jest WYMAGANA — to
 * jawna kolekcja tenanta z rejestru (lib/tenants); produkt nie zgaduje nazw kolekcji
 * (brak jawnego wskazania to błąd programisty/ integracji, nie fallback na domyślki).
 * Wagi fuzji per tenant (`options.vectorWeight`,
 * `options.textWeight`): FTS `simple` nie zna polskiej fleksji, więc tenant PL może przesunąć
 * ciężar na wektor bez zmiany SQL.
 * @param {{ query: string, language?: string, collectionName?: string|null, limit?: number, sourceFilePath?: string|null, route?: string|null }} input
 * @param {{ pool?: any, createEmbedding?: (query: string) => Promise<number[]>, candidateLimit?: number, vectorWeight?: number, textWeight?: number }} [options]
 */
export async function queryDocuments(input, options = {}) {
  const query = requiredString(input?.query, "query");
  const language = normalizeLanguage(input?.language || inferLanguageFromCollection(input?.collectionName));
  const collectionName = requiredString(input?.collectionName, "collectionName");
  const vectorWeight = fusionWeight(options.vectorWeight, VECTOR_WEIGHT);
  const textWeight = fusionWeight(options.textWeight, TEXT_WEIGHT);
  const limit = Math.max(1, Math.min(Number(input?.limit || DEFAULT_QUERY_LIMIT), 20));
  const candidateLimit = Math.max(limit, Number(options.candidateLimit || DEFAULT_CANDIDATE_LIMIT));
  const createEmbedding = options.createEmbedding;
  const pool = options.pool || getPool();
  const embedding = createEmbedding
    ? await createEmbedding(query)
    : await createQueryEmbedding(query);

  // rozmiar wektora z konfiguracji (env), nie ze stałej — rzutowanie ::halfvec(N) w SQL musi
  // podążać za modelem (kolumna jest bezwymiarowa od migracji 004)
  const result = await pool.query(
    getHybridQuerySql(getEmbeddingConfig().vectorSize),
    [
      toVectorLiteral(embedding),
      buildTextSearchQuery(query),
      collectionName,
      language,
      candidateLimit,
      limit,
      vectorWeight,
      RRF_K,
      textWeight,
      typeof input?.sourceFilePath === "string" && input.sourceFilePath.trim()
        ? input.sourceFilePath.trim()
        : null,
      buildRouteCandidates(input?.route),
    ]
  );

  return buildDocumentObjects(result.rows);
}

export async function listActiveDocumentObjects(input, pool = getPool()) {
  const collectionName = requiredString(input?.collectionName, "collectionName");
  const language = normalizeLanguage(input?.language || inferLanguageFromCollection(collectionName));

  const result = await pool.query(
    `
      SELECT id, title, text, file_path, metadata
      FROM document_chunks
      WHERE collection_name = $1
        AND language = $2
        AND is_active = true
      ORDER BY created_at ASC
      LIMIT 10000
    `,
    [collectionName, language]
  );

  return buildDocumentObjects(result.rows);
}
