// @ts-check
// Feedback użytkownika (kciuk w górę / w dół) → Langfuse score — plan docs/ai-native-ui-plan.md §4.2, E1c.
// Wspólne dla site-chatu (same-origin) i Ask CGC w docs (inny origin → nagłówki CORS).
//
// Model zagrożeń: endpoint ZAPISUJE score po `traceId` (UUID v4 nieodgadywalny, brak odczytu),
// więc kontrola originu nic nie chroni (CORS blokuje odczyt, nie zapis) — obcy origin dostaje
// 200 BEZ nagłówków CORS (przeglądarka nie odda odpowiedzi), nie 403. Ochrona = walidacja,
// rate limit fail-closed (endpoint zapisu) i idempotentne `id` (spam głosami nadpisuje jeden score).

import { applyCorsHeaders, applyTenantCorsHeaders, getClientIp } from "../apiGuards.mjs";
import { checkDocsChatRateLimit } from "../docsChat/rateLimit.mjs";

export const FEEDBACK_SCORE_NAME = "user-feedback";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} body
 * @returns {{ ok: true, traceId: string, value: 1|-1 } | { ok: false, error: string }}
 */
export function validateFeedbackBody(body) {
  const { traceId, value } = /** @type {{ traceId?: unknown, value?: unknown }} */ (body || {});
  if (typeof traceId !== "string" || !UUID_V4.test(traceId)) {
    return { ok: false, error: "traceId must be a UUID v4" };
  }
  if (value !== 1 && value !== -1) {
    return { ok: false, error: "value must be 1 or -1" };
  }
  return { ok: true, traceId: traceId.toLowerCase(), value };
}

/**
 * @param {{
 *   langfuseService?: { enabled: boolean, score: (input: { traceId: string, name: string, value: number, id?: string }) => boolean, flushAsync: () => Promise<void> },
 *   checkRateLimit?: (input: { clientIp: string }, options?: { env?: Record<string, string|undefined> }) => Promise<{ allowed: boolean }>,
 *   env?: Record<string, string|undefined>,
 *   tenant?: import("../tenants/registry.mjs").TenantConfig,
 * }} [options]
 *   `tenant` — CORS z wzorców tenanta i bucket limitera `feedback:<tenant>:<ip>`; bez tenanta
 *   ścieżka legacy (allowlista z env, bucket `feedback:<ip>`).
 */
export function createFeedbackHandler(options = {}) {
  const { langfuseService, tenant } = options;
  const checkRateLimit = options.checkRateLimit || checkDocsChatRateLimit;
  const env = options.env || process.env;
  const bucketPrefix = tenant ? `feedback:${tenant.id}:` : "feedback:";

  /**
   * @param {any} req
   * @param {any} res
   */
  return async function feedbackHandler(req, res) {
    // nagłówki CORS tylko dla dozwolonego originu; wynik nie decyduje o dostępie (patrz nagłówek pliku)
    if (tenant) {
      applyTenantCorsHeaders(req, res, tenant.cors.origins);
    } else {
      applyCorsHeaders(req, res, env);
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST", "OPTIONS"]);
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const contentType = String(req.headers?.["content-type"] || "");
    if (!contentType.toLowerCase().includes("application/json")) {
      res.status(415).json({ error: "Content-Type must be application/json" });
      return;
    }

    const parsed = validateFeedbackBody(req.body);
    if (parsed.ok === false) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // rate limit FAIL-CLOSED — to endpoint zapisu (inaczej niż fail-open site-chatu; plan §11).
    // Osobny limit (FEEDBACK_RATE_LIMIT_MAX_REQUESTS, domyślnie 60/okno): za NAT-em firmowym
    // wielu użytkowników dzieli IP, a jeden klik = jedno żądanie — 20/10 min docs-chatu by nie starczyło.
    try {
      const rate = await checkRateLimit(
        { clientIp: `${bucketPrefix}${getClientIp(req, env)}` },
        {
          env: {
            ...env,
            DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS: env.FEEDBACK_RATE_LIMIT_MAX_REQUESTS ?? "60",
          },
        }
      );
      if (!rate.allowed) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }
    } catch (rateError) {
      console.error(
        "Feedback rate limit check failed:",
        rateError instanceof Error ? rateError.message : rateError
      );
      res.status(503).json({ error: "Feedback temporarily unavailable" });
      return;
    }

    if (!langfuseService || !langfuseService.enabled) {
      // uczciwie: przyjęte, ale nigdzie nie zapisane (Langfuse wyłączony w tym środowisku)
      res.status(202).json({ stored: false });
      return;
    }

    try {
      langfuseService.score({
        id: `${FEEDBACK_SCORE_NAME}:${parsed.traceId}`,
        traceId: parsed.traceId,
        name: FEEDBACK_SCORE_NAME,
        value: parsed.value,
      });
      await langfuseService.flushAsync();
      res.status(200).json({ stored: true });
    } catch (error) {
      console.warn(
        "Feedback: Langfuse score failed:",
        error instanceof Error ? error.message : error
      );
      res.status(202).json({ stored: false });
    }
  };
}
