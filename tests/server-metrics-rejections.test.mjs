import assert from "node:assert/strict";
import test from "node:test";

import { createMetrics } from "../lib/server/metrics.mjs";

test("chat rejections counter is exposed per tenant and reason (SSE rejections are HTTP 200)", async () => {
  const metrics = createMetrics();
  metrics.observeChatRejection({ tenant: "tst", reason: "concurrency_limited" });
  metrics.observeChatRejection({ tenant: "tst", reason: "concurrency_limited" });
  metrics.observeChatRejection({ tenant: "cgc", reason: "rate_limited" });

  const { body } = await metrics.expose();
  assert.match(body, /docs_chat_chat_rejections_total\{tenant="tst",reason="concurrency_limited"\} 2/);
  assert.match(body, /docs_chat_chat_rejections_total\{tenant="cgc",reason="rate_limited"\} 1/);
});
