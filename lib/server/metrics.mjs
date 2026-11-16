// @ts-check
// Metryki Prometheus serwisu docs-chat-api (plan wielodostępu §3.4: minimum obserwowalności).
// Etykieta `route` to WZORZEC trasy z routera (/api/v1/chat), nigdy surowa ścieżka —
// inaczej każdy importId/tenant z palca eksplodowałby kardynalność. Alerty (Prometheus):
//   - 5xx: sum(rate(docs_chat_http_requests_total{status=~"5.."}[5m])) > 0.05 * sum(rate(...[5m]))
//   - p95 czasu: histogram_quantile(0.95, docs_chat_http_request_duration_seconds_bucket{route=~".*chat"})
//   - limiter CZATU: odrzuty idą w strumieniu SSE (HTTP 200!) — alert na
//     increase(docs_chat_chat_rejections_total[1h]) > 0 per tenant/reason;
//     status 429 w http_requests_total ma wyłącznie endpoint feedback

import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * @typedef {Object} AppMetrics
 * @property {(input: { method: string, route: string, status: number, tenant: string, durationMs: number }) => void} observeRequest
 * @property {(input: { tenant: string, reason: "rate_limited"|"concurrency_limited"|"upstream_rate_limited" }) => void} observeChatRejection
 * @property {() => Promise<{ contentType: string, body: string }>} expose
 */

/**
 * @param {{ prefix?: string }} [options]
 * @returns {AppMetrics}
 */
export function createMetrics(options = {}) {
  const prefix = options.prefix ?? "docs_chat_";
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix });

  const requests = new Counter({
    name: `${prefix}http_requests_total`,
    help: "Żądania HTTP serwisu docs-chat-api",
    labelNames: ["method", "route", "status", "tenant"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: `${prefix}http_request_duration_seconds`,
    help: "Czas obsługi żądania (dla SSE: do zamknięcia strumienia)",
    labelNames: ["method", "route", "tenant"],
    // czaty trwają sekundy–minuty (LLM), reszta milisekundy
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180],
    registers: [registry],
  });

  const chatRejections = new Counter({
    name: `${prefix}chat_rejections_total`,
    help: "Odrzuty czatu wysyłane w strumieniu SSE (HTTP 200): limiter per IP, brak slotu, 429 z gatewaya",
    labelNames: ["tenant", "reason"],
    registers: [registry],
  });

  return {
    observeChatRejection({ tenant, reason }) {
      chatRejections.inc({ tenant, reason });
    },
    observeRequest({ method, route, status, tenant, durationMs }) {
      const labels = { method, route, tenant };
      requests.inc({ ...labels, status: String(status) });
      duration.observe(labels, durationMs / 1000);
    },
    async expose() {
      return { contentType: registry.contentType, body: await registry.metrics() };
    },
  };
}
