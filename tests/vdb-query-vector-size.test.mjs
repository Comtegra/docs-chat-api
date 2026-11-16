// Rozmiar wektora w SQL zapytania hybrydowego podąża za EMBEDDING_VECTOR_SIZE z env
// (kolumna jest bezwymiarowa od migracji 004 — rzutowanie ::halfvec(N) robi aplikacja).
import assert from "node:assert/strict";
import test from "node:test";

import { queryDocuments } from "../lib/vdb/documents.mjs";

test("queryDocuments buduje SQL z rozmiarem z env, nie ze stałej", async () => {
  const previous = process.env.EMBEDDING_VECTOR_SIZE;
  process.env.EMBEDDING_VECTOR_SIZE = "4096";
  try {
    const captured = [];
    const pool = {
      async query(sql, params) {
        captured.push(sql);
        return { rows: [] };
      },
    };
    await queryDocuments(
      { query: "test", language: "pl", collectionName: "tst-docs-pl" },
      { pool, createEmbedding: async () => Array(4096).fill(0) }
    );
    assert.match(captured[0], /halfvec\(4096\)/);
    assert.doesNotMatch(captured[0], /halfvec\(3584\)/);
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_VECTOR_SIZE;
    else process.env.EMBEDDING_VECTOR_SIZE = previous;
  }
});
