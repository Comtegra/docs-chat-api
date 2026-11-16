import assert from "node:assert/strict";
import test from "node:test";

import { retrieveDocsChatContext } from "../lib/docsChat/retrieval.mjs";
import { validateTenantConfig } from "../lib/tenants/registry.mjs";
import { syntheticTenant } from "./helpers/tenants.mjs";

test("embedding pytania idzie klientem (kluczem) tenanta — koszt per klient na llmproxy", async () => {
  const tenant = validateTenantConfig(syntheticTenant({}), { prompts: ["cgc"] });
  const seen = [];
  const tenantClient = {
    embeddings: {
      create: async ({ model, input }, requestOptions) => {
        seen.push({ model, input, requestOptions });
        return { data: input.map((_, index) => ({ index, embedding: Array(4).fill(0.1) })) };
      },
    },
  };
  const pool = { async query() { return { rows: [] }; } };
  const previous = process.env.EMBEDDING_VECTOR_SIZE;
  process.env.EMBEDDING_VECTOR_SIZE = "4";
  try {
    await retrieveDocsChatContext(
      { prompt: "jak założyć sprawę", locale: "pl", scope: "all", page: null },
      { tenant, llmClient: tenantClient, env: { EMBEDDING_VECTOR_SIZE: "4" }, signal: new AbortController().signal, queryOptions: { pool } }
    );
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_VECTOR_SIZE; else process.env.EMBEDDING_VECTOR_SIZE = previous;
  }
  assert.equal(seen.length, 1, "embedding policzony klientem tenanta, nie domyślnym");
  assert.deepEqual(seen[0].input, ["jak założyć sprawę"]);
  // ścieżka czatu: bez ponowień SDK (Retry-After do 59 s), krótki timeout, abort klienta
  assert.equal(seen[0].requestOptions.maxRetries, 0);
  assert.equal(seen[0].requestOptions.timeout, 15_000);
  assert.ok(seen[0].requestOptions.signal instanceof AbortSignal);
});
