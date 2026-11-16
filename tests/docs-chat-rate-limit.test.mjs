import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDocsChatRateLimit,
  hashRateLimitKey,
} from "../lib/docsChat/rateLimit.mjs";

test("hashes rate limit keys without storing raw IP addresses", () => {
  const first = hashRateLimitKey("203.0.113.7", "salt-a");
  const second = hashRateLimitKey("203.0.113.7", "salt-b");

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /203\.0\.113\.7/);
});

test("uses an atomic postgres window counter before LLM work", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ON CONFLICT/.test(sql)) {
        return { rows: [{ request_count: "3" }] };
      }
      return { rows: [] };
    },
  };

  const result = await checkDocsChatRateLimit(
    { clientIp: "203.0.113.7" },
    {
      pool,
      env: {
        DOCS_CHAT_RATE_LIMIT_SALT: "secret",
        DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS: "3",
        DOCS_CHAT_RATE_LIMIT_WINDOW_SECONDS: "600",
      },
    }
  );

  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /DELETE FROM docs_chat_rate_limits/);
  assert.match(calls[0].sql, /LIMIT 1000/);
  assert.match(calls[1].sql, /INSERT INTO docs_chat_rate_limits/);
  assert.match(calls[1].sql, /ON CONFLICT/);
  assert.notEqual(calls[1].params[0], "203.0.113.7");
});

test("blocks when the postgres-backed rate limit is exhausted", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ON CONFLICT/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await checkDocsChatRateLimit(
    { clientIp: "203.0.113.7" },
    {
      pool,
      env: {
        DOCS_CHAT_RATE_LIMIT_SALT: "secret",
        DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS: "3",
        DOCS_CHAT_RATE_LIMIT_WINDOW_SECONDS: "600",
      },
    }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /ON CONFLICT/);
});

test("cleanup uses a fixed 24h retention, not the caller's window (shared table across buckets)", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return /ON CONFLICT/.test(sql) ? { rows: [{ request_count: "1" }] } : { rows: [] };
    },
  };

  await checkDocsChatRateLimit({ clientIp: "203.0.113.7", windowSeconds: 3600, maxRequests: 60 }, { pool, env: {} });

  assert.match(calls[0].sql, /interval '24 hours'/);
  assert.equal(calls[0].params, undefined);
  assert.equal(calls[1].params[1], 3600); // okno bucketa zostaje w upsercie
});
