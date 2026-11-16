import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ClientDisconnectedError, HttpError, enhanceResponse, normalizePath, readJsonBody } from "../lib/server/http.mjs";

function fakeReq({ method = "POST", body = "", headers = {} } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(stream, { method, headers: { "content-type": "application/json", ...headers } });
}

test("readJsonBody parses JSON, treats empty bodies as {}, ignores bodies on GET/OPTIONS", async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ body: '{"prompt":"q"}' })), { prompt: "q" });
  assert.deepEqual(await readJsonBody(fakeReq({ body: "" })), {});
  assert.deepEqual(await readJsonBody(fakeReq({ method: "GET", body: "ignored" })), {});
  assert.deepEqual(await readJsonBody(fakeReq({ method: "OPTIONS" })), {});
});

test("readJsonBody enforces the byte limit (declared and actual), content type and JSON validity", async () => {
  await assert.rejects(
    readJsonBody(fakeReq({ body: "x".repeat(10), headers: { "content-length": "10" } }), { maxBytes: 5 }),
    (error) => error instanceof HttpError && error.status === 413
  );
  await assert.rejects(
    readJsonBody(fakeReq({ body: JSON.stringify({ prompt: "x".repeat(100) }) }), { maxBytes: 50 }),
    (error) => error instanceof HttpError && error.status === 413
  );
  await assert.rejects(
    readJsonBody(fakeReq({ body: "prompt=q", headers: { "content-type": "text/plain" } })),
    (error) => error instanceof HttpError && error.status === 415
  );
  await assert.rejects(
    readJsonBody(fakeReq({ body: "{not json" })),
    (error) => error instanceof HttpError && error.status === 400
  );
});

test("enhanceResponse adds chainable status() and json() with content headers", () => {
  const writes = [];
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      writes.push(body);
    },
  };
  const enhanced = enhanceResponse(res);
  enhanced.status(404).json({ error: "Not found" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(res.headers["Content-Length"], String(Buffer.byteLength('{"error":"Not found"}')));
  assert.deepEqual(writes, ['{"error":"Not found"}']);
});

test("normalizePath strips query/hash and trailing slashes, rejects traversal", () => {
  assert.equal(normalizePath("/api/v1/chat?x=1#y"), "/api/v1/chat");
  assert.equal(normalizePath("/api/v1/status/"), "/api/v1/status");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath(undefined), "/");
  assert.equal(normalizePath("/api/v1/../admin"), null);
});

test("readJsonBody: a client that drops mid-body is a disconnect, not a server error", async () => {
  const req = new Readable({ read() {} });
  Object.assign(req, { method: "POST", headers: { "content-type": "application/json", "content-length": "100" } });
  req.push(Buffer.from("{"));
  process.nextTick(() => req.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
  await assert.rejects(readJsonBody(req), (error) => error instanceof ClientDisconnectedError);
});
