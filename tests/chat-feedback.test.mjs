import assert from "node:assert/strict";
import test from "node:test";

import {
  FEEDBACK_SCORE_NAME,
  createFeedbackHandler,
  validateFeedbackBody,
} from "../lib/chat/feedbackHandler.mjs";

const TRACE = "8af13fd5-0d36-40ef-9659-4574e3181e36";
const ENV = { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com", DOCS_CHAT_TRUST_PROXY_HEADERS: "true" };

function createReq({ method = "POST", body, headers = {} } = {}) {
  return {
    method,
    body,
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.7",
      ...headers,
    },
    socket: { remoteAddress: "198.51.100.8" },
  };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
}

function createLangfuseSpy({ enabled = true, throwOnFlush = false } = {}) {
  const scores = [];
  let flushes = 0;
  return {
    scores,
    get flushes() {
      return flushes;
    },
    enabled,
    score(input) {
      if (!enabled) return false;
      scores.push(input);
      return true;
    },
    async flushAsync() {
      flushes++;
      if (throwOnFlush) throw new Error("langfuse down");
    },
  };
}

const allow = async () => ({ allowed: true });

test("validateFeedbackBody: UUID v4 traceId (case-insensitive, normalized to lowercase) and value ∈ {1,-1}", () => {
  assert.deepEqual(validateFeedbackBody({ traceId: TRACE.toUpperCase(), value: 1 }), {
    ok: true,
    traceId: TRACE,
    value: 1,
  });
  assert.equal(validateFeedbackBody({ traceId: TRACE, value: -1 }).ok, true);
  assert.deepEqual(validateFeedbackBody({ traceId: "not-a-uuid", value: 1 }), {
    ok: false,
    error: "traceId must be a UUID v4",
  });
  // v1 UUID (version nibble 1) is rejected
  assert.equal(validateFeedbackBody({ traceId: "8af13fd5-0d36-10ef-9659-4574e3181e36", value: 1 }).ok, false);
  assert.deepEqual(validateFeedbackBody({ traceId: TRACE, value: 0 }), {
    ok: false,
    error: "value must be 1 or -1",
  });
  assert.equal(validateFeedbackBody({ traceId: TRACE, value: "1" }).ok, false);
  assert.equal(validateFeedbackBody(undefined).ok, false);
});

test("stores a numeric score with a deterministic id (idempotent) and flushes; 200 {stored:true}", async () => {
  const langfuse = createLangfuseSpy();
  const handler = createFeedbackHandler({ langfuseService: langfuse, checkRateLimit: allow, env: ENV });
  const res = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: -1 } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonPayload, { stored: true });
  assert.deepEqual(langfuse.scores, [
    { id: `${FEEDBACK_SCORE_NAME}:${TRACE}`, traceId: TRACE, name: FEEDBACK_SCORE_NAME, value: -1 },
  ]);
  assert.equal(langfuse.flushes, 1);
});

test("same-origin browser POST (Origin = site itself, not on the docs allowlist) and non-browser (no Origin): 200, no CORS headers", async () => {
  const handler = createFeedbackHandler({ langfuseService: createLangfuseSpy(), checkRateLimit: allow, env: ENV });
  const browser = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: 1 }, headers: { origin: "https://cgc.comtegra.cloud" } }), browser);
  assert.equal(browser.statusCode, 200);
  assert.equal(browser.headers["Access-Control-Allow-Origin"], undefined);
  const curl = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: 1 } }), curl);
  assert.equal(curl.statusCode, 200);
});

test("feedback uses its own rate-limit budget (FEEDBACK_RATE_LIMIT_MAX_REQUESTS, default 60) on the shared limiter", async () => {
  const seen = [];
  const handler = createFeedbackHandler({
    langfuseService: createLangfuseSpy(),
    checkRateLimit: async (input, options) => {
      seen.push(options?.env?.DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS);
      return { allowed: true };
    },
    env: ENV,
  });
  await handler(createReq({ body: { traceId: TRACE, value: 1 } }), createRes());
  const tuned = createFeedbackHandler({
    langfuseService: createLangfuseSpy(),
    checkRateLimit: async (input, options) => {
      seen.push(options?.env?.DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS);
      return { allowed: true };
    },
    env: { ...ENV, FEEDBACK_RATE_LIMIT_MAX_REQUESTS: "5" },
  });
  await tuned(createReq({ body: { traceId: TRACE, value: 1 } }), createRes());
  assert.deepEqual(seen, ["60", "5"]);
});

test("docs origin gets CORS headers (POST and OPTIONS preflight)", async () => {
  const handler = createFeedbackHandler({ langfuseService: createLangfuseSpy(), checkRateLimit: allow, env: ENV });
  const res = createRes();
  await handler(
    createReq({ body: { traceId: TRACE, value: 1 }, headers: { origin: "https://docs.example.com" } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://docs.example.com");

  const preflight = createRes();
  await handler(createReq({ method: "OPTIONS", headers: { origin: "https://docs.example.com" } }), preflight);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

test("foreign origin: 200 WITHOUT CORS headers (browser hides the response; nothing to protect on a write-by-UUID endpoint)", async () => {
  const langfuse = createLangfuseSpy();
  const handler = createFeedbackHandler({ langfuseService: langfuse, checkRateLimit: allow, env: ENV });
  const res = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: 1 }, headers: { origin: "https://evil.example" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(langfuse.scores.length, 1);
});

test("405 for non-POST, 415 without JSON content-type, 400 for invalid body — before the limiter", async () => {
  let limiterCalls = 0;
  const handler = createFeedbackHandler({
    langfuseService: createLangfuseSpy(),
    checkRateLimit: async () => {
      limiterCalls++;
      return { allowed: true };
    },
    env: ENV,
  });
  const r405 = createRes();
  await handler(createReq({ method: "GET" }), r405);
  assert.equal(r405.statusCode, 405);
  assert.deepEqual(r405.headers.Allow, ["POST", "OPTIONS"]);

  const r415 = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: 1 }, headers: { "content-type": "text/plain" } }), r415);
  assert.equal(r415.statusCode, 415);

  const r400 = createRes();
  await handler(createReq({ body: { traceId: "x", value: 1 } }), r400);
  assert.equal(r400.statusCode, 400);
  assert.equal(limiterCalls, 0);
});

test("rate limit is fail-closed: 429 when denied, 503 when the limiter itself fails; key feedback:<ip>", async () => {
  const keys = [];
  const denied = createFeedbackHandler({
    langfuseService: createLangfuseSpy(),
    checkRateLimit: async ({ clientIp }) => {
      keys.push(clientIp);
      return { allowed: false };
    },
    env: ENV,
  });
  const r429 = createRes();
  await denied(createReq({ body: { traceId: TRACE, value: 1 } }), r429);
  assert.equal(r429.statusCode, 429);
  assert.deepEqual(keys, ["feedback:203.0.113.7"]);

  const broken = createFeedbackHandler({
    langfuseService: createLangfuseSpy(),
    checkRateLimit: async () => {
      throw new Error("db down");
    },
    env: ENV,
  });
  const r503 = createRes();
  await broken(createReq({ body: { traceId: TRACE, value: 1 } }), r503);
  assert.equal(r503.statusCode, 503);
});

test("Langfuse disabled → 202 {stored:false} (honest: accepted, not persisted)", async () => {
  const handler = createFeedbackHandler({
    langfuseService: createLangfuseSpy({ enabled: false }),
    checkRateLimit: allow,
    env: ENV,
  });
  const res = createRes();
  await handler(createReq({ body: { traceId: TRACE, value: 1 } }), res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.jsonPayload, { stored: false });

  const none = createFeedbackHandler({ checkRateLimit: allow, env: ENV });
  const res2 = createRes();
  await none(createReq({ body: { traceId: TRACE, value: 1 } }), res2);
  assert.equal(res2.statusCode, 202);
});

test("Langfuse flush failure → 202 {stored:false} and a warning, never a 5xx", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const handler = createFeedbackHandler({
      langfuseService: createLangfuseSpy({ throwOnFlush: true }),
      checkRateLimit: allow,
      env: ENV,
    });
    const res = createRes();
    await handler(createReq({ body: { traceId: TRACE, value: 1 } }), res);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.jsonPayload, { stored: false });
    assert.ok(warnings.some((w) => w.includes("Langfuse score failed")));
  } finally {
    console.warn = originalWarn;
  }
});
