import assert from "node:assert/strict";
import test from "node:test";

import { createDocsChatHandler } from "../lib/docsChat/handler.mjs";
import { createSseRes, parseFrames } from "./helpers/sseMocks.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_TRACE_ID = "22222222-2222-4222-8222-222222222222";

function createReq({ method = "POST", body = {}, headers = {} } = {}) {
  return {
    method,
    body,
    headers: {
      origin: "https://docs.example.com",
      "x-forwarded-for": "203.0.113.7",
      ...headers,
    },
    socket: { remoteAddress: "198.51.100.8" },
  };
}

// mock `res` = EventEmitter z semantyką writableEnded/destroyed/'close' (tests/helpers/sseMocks.mjs)
const createRes = createSseRes;
const parseSseChunks = parseFrames;

const DOC_1 = {
  id: "doc-1",
  score: 0.42,
  properties: {
    title: "Create a volume",
    text: "# Create a volume\nUse cgc volume create.",
    file_path: "Volumes-management/create-a-volume.md",
    metadata: {
      route: "/Volumes-management/create-a-volume",
      sourceFilePath: "Volumes-management/create-a-volume.md",
    },
  },
};
const PAGE_BODY = {
  prompt: "How do I create a volume?",
  locale: "en",
  scope: "page",
  page: {
    source: "@site/docs/Volumes-management/create-a-volume.md",
    permalink: "/Volumes-management/create-a-volume",
    title: "Create a volume",
  },
};
const SOURCES_FRAME = {
  type: "sources",
  sources: [
    {
      title: "Create a volume",
      route: "/Volumes-management/create-a-volume",
      url: "/Volumes-management/create-a-volume",
      snippet: "Use cgc volume create.",
      score: 0.42,
    },
  ],
};
const STEP_RETRIEVE_RUNNING = { type: "step", id: "retrieve", status: "running" };
const STEP_RETRIEVE_DONE = { type: "step", id: "retrieve", status: "done", meta: { count: 1 } };
const STEP_ANSWER_RUNNING = { type: "step", id: "answer", status: "running", meta: { model: "test-model" } };
const STEP_ANSWER_DONE = { type: "step", id: "answer", status: "done" };

test("handles CORS preflight for the configured docs origin", async () => {
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
  });
  const res = createRes();

  await handler(createReq({ method: "OPTIONS" }), res);

  assert.equal(res.statusCode, 204);
  assert.equal(
    res.headers["Access-Control-Allow-Origin"],
    "https://docs.example.com"
  );
  assert.equal(res.writableEnded, true);
});

test("streams steps, sources, content chunks, and done{traceId} for a valid docs chat request", async () => {
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [
      {
        id: "doc-1",
        score: 0.42,
        properties: {
          title: "Create a volume",
          text: "# Create a volume\nUse cgc volume create.",
          file_path: "Volumes-management/create-a-volume.md",
          metadata: {
            route: "/Volumes-management/create-a-volume",
            sourceFilePath: "Volumes-management/create-a-volume.md",
          },
        },
      },
    ],
    streamCompletion: async function* () {
      yield { type: "content", content: "Use " };
      yield { type: "content", content: "`cgc volume create`." };
    },
  });
  const res = createRes();

  await handler(
    createReq({
      body: {
        prompt: "How do I create a volume?",
        locale: "en",
        scope: "page",
        page: {
          source: "@site/docs/Volumes-management/create-a-volume.md",
          permalink: "/Volumes-management/create-a-volume",
          title: "Create a volume",
        },
      },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  const frames = parseSseChunks(res.chunks);
  assert.deepEqual(frames.slice(0, -1), [
    STEP_RETRIEVE_RUNNING,
    SOURCES_FRAME,
    STEP_RETRIEVE_DONE,
    STEP_ANSWER_RUNNING,
    { type: "content", content: "Use " },
    { type: "content", content: "`cgc volume create`." },
    STEP_ANSWER_DONE,
  ]);
  assert.deepEqual(frames.at(-1), { type: "done", traceId: null }); // bez Langfuse: nie ma czego oceniać
  assert.equal(res.writableEnded, true);
});

test("forwards reasoning as its own event and excludes it from the recorded answer", async () => {
  const traces = [];
  const langfuseService = {
    createTrace(options) {
      traces.push({ options });
      return { id: options.id };
    },
    async finalizeTrace(trace, input, output) {
      traces.push({ output });
    },
  };
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService,
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [
      {
        id: "doc-1",
        score: 0.42,
        properties: {
          title: "Create a volume",
          text: "# Create a volume\nUse cgc volume create.",
          file_path: "Volumes-management/create-a-volume.md",
          metadata: {
            route: "/Volumes-management/create-a-volume",
            sourceFilePath: "Volumes-management/create-a-volume.md",
          },
        },
      },
    ],
    streamCompletion: async function* () {
      yield { type: "reasoning", content: "Let me check the volume docs." };
      yield { type: "content", content: "Use " };
      yield { type: "content", content: "`cgc volume create`." };
    },
  });
  const res = createRes();

  await handler(
    createReq({
      body: {
        prompt: "How do I create a volume?",
        locale: "en",
        scope: "all",
      },
    }),
    res
  );

  const frames = parseSseChunks(res.chunks);
  assert.deepEqual(frames.slice(0, -1), [
    STEP_RETRIEVE_RUNNING,
    SOURCES_FRAME,
    STEP_RETRIEVE_DONE,
    STEP_ANSWER_RUNNING,
    { type: "reasoning", content: "Let me check the volume docs." },
    { type: "content", content: "Use " },
    { type: "content", content: "`cgc volume create`." },
    STEP_ANSWER_DONE,
  ]);
  assert.equal(frames.at(-1).type, "done");
  assert.match(frames.at(-1).traceId, UUID_V4);

  const finalize = traces.find((entry) => entry.output);
  assert.deepEqual(finalize.output, [
    { role: "assistant", content: "Use `cgc volume create`." },
  ]);
});

test("records docs chat trace metadata when observability is provided", async () => {
  const traces = [];
  const langfuseService = {
    createTrace(options) {
      traces.push({ options });
      return { id: options.id };
    },
    async finalizeTrace(trace, input, output, metadata) {
      traces.push({ trace, input, output, metadata });
    },
  };
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService,
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [
      {
        id: "doc-1",
        score: 0.42,
        properties: {
          title: "Create a volume",
          text: "# Create a volume\nUse cgc volume create.",
          file_path: "Volumes-management/create-a-volume.md",
          metadata: {
            route: "/Volumes-management/create-a-volume",
            sourceFilePath: "Volumes-management/create-a-volume.md",
          },
        },
      },
    ],
    streamCompletion: async function* () {
      yield { type: "content", content: "Use cgc volume create." };
    },
  });
  const res = createRes();

  await handler(
    createReq({
      body: {
        prompt: "How do I create a volume?",
        locale: "en",
        scope: "page",
        page: {
          source: "@site/docs/Volumes-management/create-a-volume.md",
          permalink: "/Volumes-management/create-a-volume",
          title: "Create a volume",
        },
      },
    }),
    res
  );

  assert.equal(traces.length, 2);
  assert.equal(traces[0].options.name, "DocsChat");
  assert.equal(traces[1].input, "How do I create a volume?");
  assert.deepEqual(traces[1].output, [
    { role: "assistant", content: "Use cgc volume create." },
  ]);
  assert.deepEqual(traces[1].metadata, {
    scope: "page",
    locale: "EN",
    route: "/Volumes-management/create-a-volume",
    sourceFilePath: "Volumes-management/create-a-volume.md",
    retrievedSourceCount: 1,
  });
});

test("returns no_context without calling the LLM when page retrieval is empty", async () => {
  let llmCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [],
    streamCompletion: async function* () {
      llmCalled = true;
      yield { type: "content", content: "never" };
    },
  });
  const res = createRes();

  await handler(
    createReq({
      body: {
        prompt: "How do I create a volume?",
        locale: "en",
        scope: "page",
        page: {
          source: "@site/docs/Volumes-management/create-a-volume.md",
          permalink: "/Volumes-management/create-a-volume",
          title: "Create a volume",
        },
      },
    }),
    res
  );

  assert.equal(llmCalled, false);
  assert.deepEqual(parseSseChunks(res.chunks), [
    STEP_RETRIEVE_RUNNING,
    { type: "step", id: "retrieve", status: "failed" },
    {
      type: "error",
      code: "no_context",
      message: "No relevant context found for this page.",
    },
  ]);
  assert.equal(res.writableEnded, true);
});

test("blocks rate-limited requests before retrieval", async () => {
  let retrievalCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: false, remaining: 0 }),
    retrieveContext: async () => {
      retrievalCalled = true;
      return [];
    },
  });
  const res = createRes();

  await handler(
    createReq({
      body: {
        prompt: "How do I create a volume?",
        locale: "en",
        scope: "all",
      },
    }),
    res
  );

  assert.equal(retrievalCalled, false);
  assert.deepEqual(parseSseChunks(res.chunks), [
    {
      type: "error",
      code: "rate_limited",
      message: "Too many requests. Please try again later.",
    },
  ]);
});

test("done.traceId equals the Langfuse trace id; null without observability (client hides thumbs)", async () => {
  const traces = [];
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        traces.push(options);
        return { id: options.id };
      },
      async finalizeTrace() {},
    },
    generateTraceId: () => FIXED_TRACE_ID,
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* () {
      yield { type: "content", content: "ok" };
    },
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);

  assert.deepEqual(parseSseChunks(res.chunks).at(-1), { type: "done", traceId: FIXED_TRACE_ID });
  assert.equal(traces[0].id, FIXED_TRACE_ID);
  assert.equal(traces[0].sessionId, FIXED_TRACE_ID);

  const noObs = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* () {
      yield { type: "content", content: "ok" };
    },
  });
  const res2 = createRes();
  await noObs(createReq({ body: PAGE_BODY }), res2);
  assert.deepEqual(parseSseChunks(res2.chunks).at(-1), { type: "done", traceId: null });

  // serwis obecny, ale wyłączony (LANGFUSE_ENABLED != true / brak kluczy) → też null
  const disabledObs = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: { enabled: false, createTrace: () => null, async finalizeTrace() {} },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* () {
      yield { type: "content", content: "ok" };
    },
  });
  const res3 = createRes();
  await disabledObs(createReq({ body: PAGE_BODY }), res3);
  assert.equal(parseSseChunks(res3.chunks).at(-1).traceId, null);
});

test("passes an abort signal to streamCompletion", async () => {
  let receivedSignal = null;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* (input, options) {
      receivedSignal = options?.signal;
      yield { type: "content", content: "ok" };
    },
  });
  await handler(createReq({ body: PAGE_BODY }), createRes());
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("client disconnect mid-stream: LLM signal aborted, no done/error frame, partial answer finalized as aborted", async () => {
  const traces = [];
  const res = createRes();
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    // jak SDK: po abort iterator kończy się bez wyjątku
    streamCompletion: async function* (input, { signal }) {
      yield { type: "content", content: "part" };
      res.simulateClientDisconnect();
      if (signal.aborted) return;
      yield { type: "content", content: "never" };
    },
  });

  await handler(createReq({ body: PAGE_BODY }), res);

  const frames = parseSseChunks(res.chunks);
  assert.deepEqual(frames.at(-1), { type: "content", content: "part" });
  assert.equal(frames.some((f) => f.type === "done" || f.type === "error"), false);
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0].output, [{ role: "assistant", content: "part" }]);
  assert.equal(traces[0].metadata.aborted, true);
  assert.equal(traces[0].metadata.retrievedSourceCount, 1);
});

test("client disconnect before the model responds (APIUserAbortError): no error frame, aborted trace, finalized once", async () => {
  const traces = [];
  const res = createRes();
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    // eslint-disable-next-line require-yield
    streamCompletion: async function* (input, { signal }) {
      res.simulateClientDisconnect();
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    },
  });

  await handler(createReq({ body: PAGE_BODY }), res);

  const frames = parseSseChunks(res.chunks);
  assert.equal(frames.some((f) => f.type === "done" || f.type === "error"), false);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].metadata.aborted, true);
});

test("LLM failure mid-stream: error frame, stream ended, trace finalized once with llm_error", async () => {
  const traces = [];
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* () {
      yield { type: "content", content: "half" };
      throw new Error("upstream 502");
    },
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);

  const frames = parseSseChunks(res.chunks);
  assert.deepEqual(frames.at(-1), {
    type: "error",
    code: "llm_error",
    message: "Failed to get a response from the documentation assistant.",
  });
  assert.equal(res.writableEnded, true);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].metadata.errorCode, "llm_error");
});

test("client disconnect during retrieval: LLM is never called, aborted trace", async () => {
  const traces = [];
  const res = createRes();
  let llmCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => {
      res.simulateClientDisconnect();
      return [DOC_1];
    },
    streamCompletion: async function* () {
      llmCalled = true;
      yield { type: "content", content: "never" };
    },
  });

  await handler(createReq({ body: PAGE_BODY }), res);

  assert.equal(llmCalled, false);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].metadata.aborted, true);
  assert.deepEqual(traces[0].output, []);
});

test("rate limiter failure is fail-closed: llm_error frame, single writeHead, trace finalized", async () => {
  const traces = [];
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => {
      throw new Error("db down");
    },
    retrieveContext: async () => [DOC_1],
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.deepEqual(parseSseChunks(res.chunks), [
    {
      type: "error",
      code: "llm_error",
      message: "Failed to get a response from the documentation assistant.",
    },
  ]);
  assert.equal(res.writableEnded, true);
  assert.equal(traces[0].metadata.errorCode, "llm_error");
});

test("retrieval throwing after headers were sent: step retrieve failed + llm_error, no double writeHead", async () => {
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => {
      throw new Error("pgvector down");
    },
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);
  assert.deepEqual(parseSseChunks(res.chunks), [
    STEP_RETRIEVE_RUNNING,
    { type: "step", id: "retrieve", status: "failed" },
    {
      type: "error",
      code: "llm_error",
      message: "Failed to get a response from the documentation assistant.",
    },
  ]);
});

test("LLM error mid-stream closes the running answer step as failed", async () => {
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [DOC_1],
    streamCompletion: async function* () {
      yield { type: "content", content: "half" };
      throw new Error("upstream 502");
    },
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);
  const frames = parseSseChunks(res.chunks);
  assert.deepEqual(frames.slice(-2), [
    { type: "step", id: "answer", status: "failed" },
    {
      type: "error",
      code: "llm_error",
      message: "Failed to get a response from the documentation assistant.",
    },
  ]);
});

test("invalid request → SSE error invalid_request (no LLM, no retrieval)", async () => {
  let retrievalCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => {
      retrievalCalled = true;
      return [DOC_1];
    },
  });
  const res = createRes();
  await handler(createReq({ body: { prompt: "", locale: "en", scope: "all" } }), res);
  assert.equal(retrievalCalled, false);
  const frames = parseSseChunks(res.chunks);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "error");
  assert.equal(frames[0].code, "invalid_request");
});

test("client disconnect while the limiter runs: no retrieval, no LLM, aborted trace", async () => {
  const traces = [];
  const res = createRes();
  let retrievalCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ output, metadata });
      },
    },
    checkRateLimit: async () => {
      res.simulateClientDisconnect();
      return { allowed: true, remaining: 4 };
    },
    retrieveContext: async () => {
      retrievalCalled = true;
      return [DOC_1];
    },
  });
  await handler(createReq({ body: PAGE_BODY }), res);
  assert.equal(retrievalCalled, false);
  assert.equal(traces[0].metadata.aborted, true);
  assert.equal(traces[0].metadata.retrievedSourceCount, 0);
});

test("Langfuse finalization throwing never breaks the docs response", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const handler = createDocsChatHandler({
      env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
      langfuseService: {
        createTrace(options) {
          return { id: options.id };
        },
        async finalizeTrace() {
          throw new Error("langfuse down");
        },
      },
      checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
      retrieveContext: async () => [DOC_1],
      streamCompletion: async function* () {
        yield { type: "content", content: "ok" };
      },
    });
    const res = createRes();
    await handler(createReq({ body: PAGE_BODY }), res);
    assert.equal(parseSseChunks(res.chunks).at(-1).type, "done");
    assert.ok(warnings.some((w) => w.includes("Langfuse finalization failed")));
  } finally {
    console.warn = originalWarn;
  }
});

test("objects without usable text are dropped BEFORE numbering: all-empty retrieval → no_context, count 0", async () => {
  const traces = [];
  let llmCalled = false;
  const handler = createDocsChatHandler({
    env: { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_MODEL: "test-model" },
    langfuseService: {
      createTrace(options) {
        return { id: options.id };
      },
      async finalizeTrace(trace, input, output, metadata) {
        traces.push({ metadata });
      },
    },
    checkRateLimit: async () => ({ allowed: true, remaining: 4 }),
    retrieveContext: async () => [
      { ...DOC_1, properties: { ...DOC_1.properties, text: "   " } },
      { ...DOC_1, id: "doc-2", properties: { ...DOC_1.properties, text: undefined } },
    ],
    streamCompletion: async function* () {
      llmCalled = true;
      yield { type: "content", content: "never" };
    },
  });
  const res = createRes();
  await handler(createReq({ body: PAGE_BODY }), res);
  assert.equal(llmCalled, false);
  const frames = parseSseChunks(res.chunks);
  assert.equal(frames.at(-1).code, "no_context");
  assert.equal(traces[0].metadata.retrievedSourceCount, 0);
});
