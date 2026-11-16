import OpenAI from "openai";

import { assertVectorSize } from "./postgres.mjs";

// Defaulty = konfiguracja produkcyjna (qwen3-embedding-8b, 4096) — instancja bez
// env-ów embeddingowych startuje z tym, co serwuje gateway (plan env-config-refactor).
export const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding-8b";
export const DEFAULT_EMBEDDING_VECTOR_SIZE = 4096;

let openAiClient;

export function getEmbeddingConfig(env = process.env) {
  const vectorSize = Number(env.EMBEDDING_VECTOR_SIZE || DEFAULT_EMBEDDING_VECTOR_SIZE);
  // literówka w EMBEDDING_VECTOR_SIZE dawała NaN: health 200, a każdy insert i każde pytanie
  // padały dopiero przy użyciu — serwis waliduje to przy starcie (server/docs-chat-api.mjs)
  if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
    throw new Error(`EMBEDDING_VECTOR_SIZE must be a positive integer, received "${env.EMBEDDING_VECTOR_SIZE}"`);
  }
  return {
    model: env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    vectorSize,
    // instrukcja dla modeli instruktażowych (Qwen3-Embedding: +1-5% jakości) — TYLKO zapytania;
    // dokumenty embedowane goło (zalecenie z karty modelu)
    queryInstruction: env.EMBEDDING_QUERY_INSTRUCTION || "",
  };
}

function getOpenAIClient(env = process.env) {
  if (!openAiClient) {
    openAiClient = new OpenAI({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
    });
  }

  return openAiClient;
}

export async function createEmbeddings(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("Embedding input must be a non-empty array");
  }

  const env = options.env || process.env;
  const { model, vectorSize } = getEmbeddingConfig(env);
  const client = options.client || getOpenAIClient(env);

  const response = await client.embeddings.create(
    {
      model,
      input: inputs,
    },
    // domyślnie 2 ponowienia (partie importu są idempotentne); ścieżka czatu nadpisuje na 0 + timeout + signal,
    // bo SDK honoruje Retry-After (do 59 s) i pytanie wisiałoby minutami trzymając slot semafora
    { maxRetries: 2, ...(options.requestOptions || {}) }
  );

  const embeddings = [...response.data]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);

  embeddings.forEach((embedding) => assertVectorSize(embedding, vectorSize));
  return embeddings;
}

export async function createEmbedding(input, options = {}) {
  const [embedding] = await createEmbeddings([input], options);
  return embedding;
}

/**
 * Embedding ZAPYTANIA (nie dokumentu): gdy EMBEDDING_QUERY_INSTRUCTION jest ustawione,
 * pytanie idzie w formacie instruktażowym `Instruct: {task}\nQuery:{query}`.
 * @param {string} query
 * @param {{ env?: Record<string, string|undefined>, client?: any, signal?: AbortSignal, requestOptions?: Record<string, unknown> }} [options]
 * @returns {Promise<number[]>}
 */
export async function createQueryEmbedding(query, options = {}) {
  const env = options.env || process.env;
  const { queryInstruction } = getEmbeddingConfig(env);
  const input = queryInstruction ? `Instruct: ${queryInstruction}\nQuery:${query}` : query;
  // zapytanie czatu: bez ponowień SDK, krótki timeout, abort z żądania klienta
  const requestOptions = { maxRetries: 0, timeout: 15_000, ...(options.signal ? { signal: options.signal } : {}), ...(options.requestOptions || {}) };
  return (await createEmbeddings([input], { ...options, requestOptions }))[0];
}
