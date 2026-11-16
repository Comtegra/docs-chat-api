import assert from "node:assert/strict";
import test from "node:test";

import { createMetrics } from "../lib/server/metrics.mjs";

test("metrics: requests counted per method/route/status/tenant, durations in seconds, prometheus exposition", async () => {
  const metrics = createMetrics({ prefix: "test_" });
  metrics.observeRequest({ method: "POST", route: "/api/v1/chat", status: 200, tenant: "tst", durationMs: 1500 });
  metrics.observeRequest({ method: "POST", route: "/api/v1/chat", status: 200, tenant: "tst", durationMs: 500 });
  metrics.observeRequest({ method: "GET", route: "/api/v1/health", status: 503, tenant: "", durationMs: 3 });

  const { contentType, body } = await metrics.expose();
  assert.match(contentType, /text\/plain/);
  assert.match(body, /test_http_requests_total\{method="POST",route="\/api\/v1\/chat",tenant="tst",status="200"\} 2/);
  assert.match(body, /test_http_requests_total\{method="GET",route="\/api\/v1\/health",tenant="",status="503"\} 1/);
  // histogram w sekundach: 1.5 s wpada do kubełka 2.5, nie 1
  assert.match(body, /test_http_request_duration_seconds_bucket\{[^}]*le="1"[^}]*route="\/api\/v1\/chat"[^}]*\} 1/);
  assert.match(body, /test_http_request_duration_seconds_bucket\{[^}]*le="2\.5"[^}]*route="\/api\/v1\/chat"[^}]*\} 2/);
  // metryki procesu (collectDefaultMetrics) obecne
  assert.match(body, /test_process_cpu_user_seconds_total/);
});
