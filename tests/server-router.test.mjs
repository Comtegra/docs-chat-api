import assert from "node:assert/strict";
import test from "node:test";

import { createRouter } from "../lib/server/router.mjs";

test("router matches literal and parameter segments, returns params, 405 allowed list or null", () => {
  const router = createRouter();
  const chat = async () => {};
  const status = async () => {};
  router.add("POST", "/api/v1/chat", chat);
  router.add("OPTIONS", "/api/v1/chat", chat);
  router.add("GET", "/api/v1/index/imports/:importId", status);
  router.add("GET", "/api/v1/health", status);

  assert.deepEqual(router.match("post", "/api/v1/chat"), { handler: chat, params: {}, pattern: "/api/v1/chat" });
  assert.deepEqual(router.match("GET", "/api/v1/health"), { handler: status, params: {}, pattern: "/api/v1/health" });
  assert.deepEqual(router.match("GET", "/api/v1/index/imports/imp-1"), {
    handler: status,
    params: { importId: "imp-1" },
    pattern: "/api/v1/index/imports/:importId",
  });
  assert.deepEqual(router.match("GET", "/api/v1/chat"), { allowed: ["POST", "OPTIONS"] });
  assert.equal(router.match("GET", "/api/v1/index"), null);
  assert.equal(router.match("GET", "/api/v1/index/imports/imp-1/extra"), null);
  assert.equal(router.match("GET", "/"), null);
});

test("router rejects parameter segments outside [A-Za-z0-9._-] (no path tricks)", () => {
  const router = createRouter();
  router.add("GET", "/api/v1/index/imports/:importId", async () => {});
  assert.equal(router.match("GET", "/api/v1/index/imports/imp%2F..%2F"), null);
  assert.equal(router.match("GET", "/api/v1/index/imports/imp@x"), null);
  assert.notEqual(router.match("GET", "/api/v1/index/imports/imp.v2"), null);
});
