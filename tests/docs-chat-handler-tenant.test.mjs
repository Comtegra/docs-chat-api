// Ścieżka TENANTA handlera docs-chat (rejestr lib/tenants). Ścieżka legacy (env) jest testowana
// w docs-chat-handler.test.mjs i musi pozostać bez zmian do migracji cgc-user-docs.
import assert from "node:assert/strict";
import test from "node:test";

// testy symulują ingress: X-Real-IP zaufany tylko z tą flagą (osobny proces per plik testów)
process.env.DOCS_CHAT_TRUST_PROXY_HEADERS = "true";

import { createDocsChatHandler } from "../lib/docsChat/handler.mjs";
import { validateTenantConfig } from "../lib/tenants/registry.mjs";
import { createSseRes, parseFrames } from "./helpers/sseMocks.mjs";

const FIXED_TRACE_ID = "22222222-2222-4222-8222-222222222222";

const TST = validateTenantConfig(
  {
    id: "tst",
    name: "Test Assistant",
    organization: "Test",
    siteUrl: "https://docs.tst.example",
    locales: ["pl"],
    defaultLocale: "pl",
    collections: { pl: "tst-docs-pl" },
    cors: { origins: ["https://docs.tst.example", "*.tst.example"] },
    limits: { perIp: { max: 60, windowSeconds: 600 } },
    model: "gemma-4-26b-a4b",
    retrieval: { vectorWeight: 0.6, textWeight: 0.4, limit: 5 },
    prompt: "cgc",
    langfuse: { enabled: true, project: "own" },
  },
  {}
);

const DOC = {
  id: "doc-1",
  score: 0.42,
  properties: {
    title: "Zakładanie sprawy",
    text: "# Zakładanie sprawy\nSprawę zakładasz w module Kwestie.",
    file_path: null,
    metadata: { route: "/manual/getting-started/zakladanie-sprawy" },
  },
};

function createReq({ method = "POST", body = {}, headers = {} } = {}) {
  return {
    method,
    body,
    headers: { "x-real-ip": "203.0.113.7", ...headers },
    socket: { remoteAddress: "198.51.100.8" },
  };
}

function happyOptions(overrides = {}) {
  const calls = { rateLimit: [], retrieve: [], llm: [], traces: [] };
  const handler = createDocsChatHandler({
    tenant: TST,
    llmClient: { marker: "tenant-llm-client" },
    generateTraceId: () => FIXED_TRACE_ID,
    langfuseService: {
      enabled: true,
      createTrace(options) {
        calls.traces.push({ createTrace: options });
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        calls.traces.push({ input, output, metadata });
      },
    },
    checkRateLimit: async (input) => {
      calls.rateLimit.push(input);
      return { allowed: true, remaining: 10 };
    },
    retrieveContext: async (request, options) => {
      calls.retrieve.push({ request, options });
      return [DOC];
    },
    streamCompletion: async function* (input, options) {
      calls.llm.push({ input, options });
      yield { type: "content", content: "Sprawę zakładasz w module Kwestie [1]." };
    },
    ...overrides,
  });
  return { handler, calls };
}

test("tenant: happy path threads collection, weights, prompt key, model, client and tags end-to-end", async () => {
  const { handler, calls } = happyOptions();
  const res = createSseRes();
  await handler(
    createReq({
      headers: { origin: "https://tst.miasto.tst.example" },
      body: { prompt: "Jak założyć sprawę?", scope: "all", client: "dXJ6YWQtMQ" },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://tst.miasto.tst.example");
  const frames = parseFrames(res.chunks);
  assert.deepEqual(frames.at(-1), { type: "done", traceId: FIXED_TRACE_ID });
  assert.deepEqual(frames.find((frame) => frame.type === "step" && frame.id === "answer" && frame.status === "running"), {
    type: "step",
    id: "answer",
    status: "running",
    meta: { model: "gemma-4-26b-a4b" },
  });

  // locale domyślne tenanta (pl) bez podawania w body
  assert.equal(calls.retrieve[0].request.locale, "PL");
  assert.equal(calls.retrieve[0].request.client, "dXJ6YWQtMQ");
  assert.equal(calls.retrieve[0].options.tenant, TST);
  assert.deepEqual(calls.retrieve[0].options.llmClient, { marker: "tenant-llm-client" }); // embedding pytania kluczem tenanta

  // limiter z bucketem tenanta i limitami z rejestru
  assert.deepEqual(calls.rateLimit, [{ clientIp: "tst:203.0.113.7", maxRequests: 60, windowSeconds: 600 }]);

  // LLM: prompt tenanta, model tenanta, klient per tenant, sygnał abortu
  assert.equal(calls.llm[0].input.promptText, undefined);
  assert.equal(calls.llm[0].options.model, "gemma-4-26b-a4b");
  assert.deepEqual(calls.llm[0].options.client, { marker: "tenant-llm-client" });
  assert.ok(calls.llm[0].options.signal instanceof AbortSignal);

  // Langfuse: tag tenanta, metadane z tenantem, id wdrożenia, modelem i źródłami (bez treści)
  assert.deepEqual(calls.traces[0].createTrace, {
    id: FIXED_TRACE_ID,
    name: "DocsChat",
    sessionId: FIXED_TRACE_ID,
    tags: ["tenant:tst"],
  });
  assert.deepEqual(calls.traces[1].metadata, {
    tenant: "tst",
    client: "dXJ6YWQtMQ",
    model: "gemma-4-26b-a4b",
    scope: "all",
    locale: "PL",
    route: null,
    sourceFilePath: null,
    sources: [{ title: "Zakładanie sprawy", route: "/manual/getting-started/zakladanie-sprawy", score: 0.42 }],
    retrievedSourceCount: 1,
  });
});

test("tenant: CORS — no Origin passes through, foreign origin is 403, preflight is 204", async () => {
  const { handler } = happyOptions();

  const noOrigin = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), noOrigin);
  assert.equal(noOrigin.statusCode, 200);
  assert.equal(noOrigin.headers["Access-Control-Allow-Origin"], undefined);

  const foreign = createSseRes();
  await handler(createReq({ headers: { origin: "https://evil.example" }, body: { prompt: "q", scope: "all" } }), foreign);
  assert.equal(foreign.statusCode, 403);
  assert.deepEqual(foreign.jsonPayload, { error: "Origin not allowed" });

  const preflight = createSseRes();
  await handler(createReq({ method: "OPTIONS", headers: { origin: "https://docs.tst.example" } }), preflight);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
});

test("tenant: locale outside the tenant's list is invalid_request; page scope still needs a permalink", async () => {
  const { handler, calls } = happyOptions();
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", locale: "en", scope: "all" } }), res);
  assert.deepEqual(parseFrames(res.chunks), [{ type: "error", code: "invalid_request", message: "locale must be pl" }]);
  assert.equal(calls.rateLimit.length, 0);

  const pageRes = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "page", page: {} } }), pageRes);
  assert.equal(parseFrames(pageRes.chunks)[0].code, "invalid_request");
});

test("tenant: invalid client id is dropped silently (attribution only, never a reason to reject)", async () => {
  const { handler, calls } = happyOptions();
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all", client: "zł\nnie ok" } }), res);
  assert.equal(parseFrames(res.chunks).at(-1).type, "done");
  assert.equal(calls.traces[1].metadata.client, null);
});

// --- timeouty serwerowe na LLM ---
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

test("tenant: first-token timeout → step answer failed + llm_error, LLM signal aborted, trace errorCode llm_timeout", async () => {
  let seenSignal = null;
  const { handler, calls } = happyOptions({
    timeouts: { firstTokenMs: 20, totalMs: 500 },
    streamCompletion: async function* (input, { signal }) {
      seenSignal = signal;
      await sleep(200, signal);
      if (signal.aborted) return;
      yield { type: "content", content: "za późno" };
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  const frames = parseFrames(res.chunks);
  assert.equal(seenSignal.aborted, true);
  assert.deepEqual(frames.slice(-2), [
    { type: "step", id: "answer", status: "failed" },
    { type: "error", code: "llm_error", message: "The model did not start answering in time. Please try again." },
  ]);
  assert.ok(!frames.some((frame) => frame.type === "content"));
  assert.equal(calls.traces[1].metadata.errorCode, "llm_timeout");
  assert.equal(calls.traces[1].metadata.timeout, "first_token");
  assert.equal(res.writableEnded, true);
});

test("tenant: total timeout mid-stream keeps the partial answer in the trace and reports a cut-off", async () => {
  const { handler, calls } = happyOptions({
    timeouts: { firstTokenMs: 500, totalMs: 40 },
    streamCompletion: async function* (input, { signal }) {
      yield { type: "content", content: "Początek " };
      await sleep(200, signal);
      if (signal.aborted) return;
      yield { type: "content", content: "koniec." };
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  const frames = parseFrames(res.chunks);
  assert.deepEqual(frames.filter((frame) => frame.type === "content"), [{ type: "content", content: "Początek " }]);
  assert.equal(frames.at(-1).code, "llm_error");
  assert.match(frames.at(-1).message, /took too long/);
  assert.deepEqual(calls.traces[1].output, [{ role: "assistant", content: "Początek " }]);
  assert.equal(calls.traces[1].metadata.timeout, "total");
});

test("tenant: a timeout that throws APIUserAbortError before the first token is still reported as a timeout", async () => {
  const { handler, calls } = happyOptions({
    timeouts: { firstTokenMs: 20, totalMs: null },
    streamCompletion: async function* (input, { signal }) {
      await sleep(200, signal);
      const error = new Error("aborted");
      error.name = "APIUserAbortError";
      throw error;
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  assert.equal(parseFrames(res.chunks).at(-1).code, "llm_error");
  assert.equal(calls.traces[1].metadata.errorCode, "llm_timeout");
});

test("tenant: client disconnect during the wait wins over the timeout (aborted, no frames)", async () => {
  const { handler, calls } = happyOptions({
    timeouts: { firstTokenMs: 100, totalMs: null },
    streamCompletion: async function* (input, { signal }) {
      await sleep(300, signal);
      return;
    },
  });
  const res = createSseRes();
  const pending = handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  await sleep(10);
  res.simulateClientDisconnect();
  await pending;
  const frames = parseFrames(res.chunks);
  assert.ok(!frames.some((frame) => frame.type === "error" || frame.type === "done"));
  assert.equal(calls.traces[1].metadata.aborted, true);
  assert.equal(calls.traces[1].metadata.errorCode, undefined);
});

function deferred() {
  /** @type {any} */ let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function waitFor(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("waitFor: timeout");
}

test("semafor per IP: jeden adres nie trzyma wielu strumieni naraz; inny adres przechodzi", async () => {
  const gate = deferred();
  const { handler, calls } = happyOptions({
    tenant: { ...TST, limits: { ...TST.limits, maxConcurrentPerIp: 1 } },
    streamCompletion: async function* (input, options) {
      calls.llm.push({ input, options });
      await gate.promise;
      yield { type: "content", content: "ok" };
    },
  });
  const resA = createSseRes();
  const inFlight = handler(createReq({ body: { prompt: "a", scope: "all" } }), resA);
  await waitFor(() => calls.llm.length === 1);

  const resSameIp = createSseRes();
  await handler(createReq({ body: { prompt: "b", scope: "all" } }), resSameIp);
  assert.equal(parseFrames(resSameIp.chunks)[0].code, "rate_limited");

  const resOtherIp = createSseRes();
  const other = handler(createReq({ body: { prompt: "c", scope: "all" }, headers: { "x-real-ip": "203.0.113.99" } }), resOtherIp);
  await waitFor(() => calls.llm.length === 2, 200);
  gate.resolve();
  await Promise.all([inFlight, other]);
  assert.equal(parseFrames(resOtherIp.chunks).at(-1).type, "done", "inny adres dostaje slot");
});

test("429 z gatewaya (limit klucza tenanta na llmproxy) → rate_limited dla użytkownika, errorCode upstream_rate_limited", async () => {
  const rejections = [];
  const { handler, calls } = happyOptions({
    onRejection: (input) => rejections.push(input.reason),
    streamCompletion: async function* () {
      const error = new Error("429 Too Many Requests");
      error.status = 429;
      throw error;
      // eslint-disable-next-line no-unreachable
      yield undefined;
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  const frames = parseFrames(res.chunks);
  assert.equal(frames.at(-1).type, "error");
  assert.equal(frames.at(-1).code, "rate_limited");
  assert.deepEqual(rejections, ["upstream_rate_limited"]);
  assert.equal(calls.traces.at(-1).metadata.errorCode, "upstream_rate_limited");
});

test("401 z gatewaya (klucz tenanta wygasł) → llm_error dla użytkownika, errorCode upstream_auth w trace", async () => {
  const { handler, calls } = happyOptions({
    streamCompletion: async function* () {
      const error = new Error("401 Unauthorized");
      error.status = 401;
      throw error;
      // eslint-disable-next-line no-unreachable
      yield undefined;
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  assert.equal(parseFrames(res.chunks).at(-1).code, "llm_error");
  assert.equal(calls.traces.at(-1).metadata.errorCode, "upstream_auth");
});

test("X-Request-ID gatewaya trafia do metadanych trace'u (korelacja z billingiem)", async () => {
  const { handler, calls } = happyOptions({
    streamCompletion: async function* (input, options) {
      options.onResponse?.({ requestId: "req-abc-123", aiGenerated: true });
      calls.llm.push({ input, options });
      yield { type: "content", content: "ok" };
    },
  });
  const res = createSseRes();
  await handler(createReq({ body: { prompt: "q", scope: "all" } }), res);
  assert.equal(calls.traces.at(-1).metadata.llmRequestId, "req-abc-123");
  assert.deepEqual(parseFrames(res.chunks).at(-1), { type: "done", traceId: FIXED_TRACE_ID, aiGenerated: true });
});
