import assert from "node:assert/strict";
import test from "node:test";

import { streamDocsChatCompletion } from "../lib/docsChat/llm.mjs";

async function* chunks() {
  yield { choices: [{ delta: { content: "hej" } }] };
}

test("streamDocsChatCompletion: withResponse → onResponse dostaje X-Request-ID i X-AI-Generated", async () => {
  const meta = [];
  const client = {
    chat: { completions: { create: () => {
      const promise = Promise.resolve(chunks());
      /** @type {any} */ (promise).withResponse = async () => ({
        data: chunks(),
        response: { headers: new Map([["x-request-id", "rid-1"], ["x-ai-generated", "true"]]) },
      });
      return promise;
    } } },
  };
  const out = [];
  for await (const delta of streamDocsChatCompletion({ prompt: "p", contextText: "", locale: "pl" }, { client, model: "m", onResponse: (m) => meta.push(m) })) out.push(delta);
  assert.deepEqual(meta, [{ requestId: "rid-1", aiGenerated: true }]);
  assert.ok(out.length >= 1);
});

test("streamDocsChatCompletion: klient bez withResponse (mock) działa jak dotąd", async () => {
  const client = { chat: { completions: { create: async () => chunks() } } };
  const out = [];
  for await (const delta of streamDocsChatCompletion({ prompt: "p", contextText: "", locale: "pl" }, { client, model: "m" })) out.push(delta);
  assert.ok(out.length >= 1);
});

import { verifyGatewayModels, createLlmClient } from "../lib/docsChat/llm.mjs";

test("verifyGatewayModels: brakujące nazwy modeli (llmproxy zwraca 401 na nieznany model — sprawdzamy na starcie)", async () => {
  const client = { models: { list: async (opts) => { assert.equal(opts.maxRetries, 0); return { data: [{ id: "gemma-4-26b-a4b" }, { id: "gte-qwen2-7b" }] }; } } };
  assert.deepEqual(await verifyGatewayModels({ client, expected: ["gemma-4-26b-a4b", "qwen3-embedding-8b"] }), {
    available: ["gemma-4-26b-a4b", "gte-qwen2-7b"],
    missing: ["qwen3-embedding-8b"],
  });
});

test("klient czatu bez ponowień SDK (429 z gatewaya ma być natychmiastowe)", () => {
  const client = createLlmClient({ OPENAI_BASE_URL: "https://llm.example/v1", OPENAI_API_KEY: "k" });
  assert.equal(client.maxRetries, 0);
});
