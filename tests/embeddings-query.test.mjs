// Embedding zapytania: format instruktażowy (Qwen3-Embedding) tylko gdy env ustawione;
// dokumentów to nie dotyczy (createEmbeddings bez zmian).
import assert from "node:assert/strict";
import test from "node:test";

import { createQueryEmbedding } from "../lib/embeddings.mjs";

function fakeClient(captured, dim = 4) {
  return {
    embeddings: {
      create: async ({ input }) => {
        captured.push(...input);
        return { data: input.map((_, index) => ({ index, embedding: Array(dim).fill(0.5) })) };
      },
    },
  };
}

test("createQueryEmbedding: bez instrukcji pytanie idzie goło", async () => {
  const captured = [];
  await createQueryEmbedding("jak założyć sprawę", {
    env: { EMBEDDING_VECTOR_SIZE: "4" },
    client: fakeClient(captured),
  });
  assert.deepEqual(captured, ["jak założyć sprawę"]);
});

test("createQueryEmbedding: EMBEDDING_QUERY_INSTRUCTION daje format Instruct/Query", async () => {
  const captured = [];
  await createQueryEmbedding("jak założyć sprawę", {
    env: {
      EMBEDDING_VECTOR_SIZE: "4",
      EMBEDDING_QUERY_INSTRUCTION: "Given a web search query, retrieve relevant passages that answer the query",
    },
    client: fakeClient(captured),
  });
  assert.equal(
    captured[0],
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:jak założyć sprawę"
  );
});
