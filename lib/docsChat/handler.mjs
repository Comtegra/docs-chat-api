// @ts-check
import { checkDocsChatRateLimit } from "./rateLimit.mjs";
import { v4 as uuidv4 } from "uuid";
import { validateDocsChatRequest } from "./request.mjs";
import {
  buildContextText,
  buildSources,
  filterUsableObjects,
  retrieveDocsChatContext,
} from "./retrieval.mjs";
import { resolveDocsChatModel, streamDocsChatCompletion } from "./llm.mjs";
import { applyCorsHeaders, applyTenantCorsHeaders, getClientIp } from "../apiGuards.mjs";
import {
  attachAbort,
  endSse,
  sendSseError,
  startSse,
  writeSse,
} from "../chat/sseWriter.mjs";

/** @typedef {import("../tenants/registry.mjs").TenantConfig} TenantConfig */

/**
 * Czy jest gdzie zapisać ocenę (Langfuse skonfigurowany). Serwis bez pola `enabled` (mocki w testach)
 * traktujemy jako włączony.
 * @param {any} langfuseService
 */
export function isObservable(langfuseService) {
  return Boolean(langfuseService) && langfuseService.enabled !== false;
}

/**
 * @param {any} langfuseService
 * @param {any} trace
 * @param {any} request
 * @param {Array<{ role: string, content: string }>} output
 * @param {Record<string, unknown>} [metadata]
 */
async function finalizeTrace(langfuseService, trace, request, output, metadata) {
  if (!langfuseService || !trace || !request) {
    return;
  }

  await langfuseService.finalizeTrace(
    trace,
    request.prompt,
    output,
    metadata
  );
}

/**
 * Polityka handlera: wszystko, co różni tenanta od ścieżki legacy (docs-chat CGC sterowany env),
 * rozwiązane RAZ przy tworzeniu handlera. Ścieżka legacy jest zachowana 1:1 (kontrakt testów
 * i produkcji) do czasu migracji cgc-user-docs na /api/v1/cgc.
 *
 * @typedef {Object} DocsChatPolicy
 * @property {string|null} tenantId
 * @property {(req: any, res: any) => { allowed: boolean }} cors
 * @property {{ defaultLocale?: string, allowedLocales?: string[] }} localePolicy
 * @property {(clientIp: string) => { clientIp: string, maxRequests?: number, windowSeconds?: number }} rateLimitInput
 * @property {{ tenant?: TenantConfig, llmClient?: any, env?: Record<string, string|undefined> }} retrievalOptions
 * @property {string} model
 * @property {string|undefined} promptText  pelny prompt instancji z DOCS_CHAT_PROMPT_FILE (dane deployu; undefined = baza/framework)
 * @property {string|undefined} persona  tekst persony z DOCS_CHAT_PERSONA_FILE (dane deployu)
 * @property {{ model?: string, client?: any }} llmOptions
 * @property {string[]|undefined} traceTags
 * @property {string} llmErrorMessage
 * @property {{ firstTokenMs: number|null, totalMs: number|null }} timeouts
 */

/**
 * Timeouty serwerowe na wywołanie modelu (plan §3.4): bez nich zawieszony vLLM trzyma połączenie,
 * aż klient sam przerwie po 30 s bezczynności. Env: DOCS_CHAT_FIRST_TOKEN_TIMEOUT_MS,
 * DOCS_CHAT_TOTAL_TIMEOUT_MS; tenant ma domyślne 55 s / 180 s, ścieżka legacy — brak (jak dotąd).
 * @param {Record<string, string|undefined>} env
 * @param {{ firstTokenMs: number|null, totalMs: number|null }} defaults
 * @param {{ firstTokenMs?: number|null, totalMs?: number|null }} [override]
 */
function resolveTimeouts(env, defaults, override) {
  /** @param {unknown} value @param {number|null} fallback */
  const parse = (value, fallback) => {
    if (value === null) return null;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  };
  return {
    firstTokenMs: parse(override?.firstTokenMs ?? env.DOCS_CHAT_FIRST_TOKEN_TIMEOUT_MS, defaults.firstTokenMs),
    totalMs: parse(override?.totalMs ?? env.DOCS_CHAT_TOTAL_TIMEOUT_MS, defaults.totalMs),
  };
}

/**
 * @param {{ tenant?: TenantConfig, llmClient?: any, env: Record<string, string|undefined>, timeouts?: { firstTokenMs?: number|null, totalMs?: number|null } }} options
 * @returns {DocsChatPolicy}
 */
function resolvePolicy(options) {
  const { tenant, env } = options;
  if (!tenant) {
    return {
      timeouts: resolveTimeouts(env, { firstTokenMs: null, totalMs: null }, options.timeouts),
      tenantId: null,
      cors: (req, res) => ({ allowed: applyCorsHeaders(req, res, env) }),
      localePolicy: {},
      rateLimitInput: (clientIp) => ({ clientIp }),
      retrievalOptions: {},
      model: resolveDocsChatModel(env),
      promptText: undefined,
      persona: undefined,
      llmOptions: {},
      traceTags: undefined,
      llmErrorMessage: "Failed to get a response from the documentation assistant.",
    };
  }
  return {
    // first-token 55 s < 60 s idle-timeout gatewaya (llmproxy timeout_read): zamykamy turę czytelnym
    // komunikatem, zanim proxy odpowie 504 w środku strumienia
    timeouts: resolveTimeouts(env, { firstTokenMs: 55_000, totalMs: 180_000 }, options.timeouts),
    tenantId: tenant.id,
    cors: (req, res) => {
      const decision = applyTenantCorsHeaders(req, res, tenant.cors.origins);
      return { allowed: decision.allowed };
    },
    localePolicy: { defaultLocale: tenant.defaultLocale, allowedLocales: tenant.locales },
    // bucket per tenant: NAT klienta nie dzieli limitu z użytkownikami innego tenanta
    rateLimitInput: (clientIp) => ({
      clientIp: `${tenant.id}:${clientIp}`,
      maxRequests: tenant.limits.perIp.max,
      windowSeconds: tenant.limits.perIp.windowSeconds,
    }),
    retrievalOptions: { tenant, llmClient: options.llmClient, env },
    model: tenant.model,
    promptText: tenant.promptText,
    persona: tenant.persona,
    llmOptions: { model: tenant.model, client: options.llmClient },
    traceTags: [`tenant:${tenant.id}`],
    llmErrorMessage: `Failed to get a response from ${tenant.name}.`,
  };
}

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   tenant?: TenantConfig,
 *   llmClient?: any,
 *   checkRateLimit?: (input: { clientIp: string, maxRequests?: number, windowSeconds?: number }) => Promise<{ allowed: boolean }>,
 *   retrieveContext?: (request: any, options?: { tenant?: TenantConfig }) => Promise<any[]>,
 *   streamCompletion?: (input: any, options: { signal?: AbortSignal, model?: string, client?: any }) => AsyncIterable<{ type: string, content: string }>,
 *   langfuseService?: any,
 *   generateTraceId?: () => string,
 *   timeouts?: { firstTokenMs?: number|null, totalMs?: number|null },
 *   onRejection?: (input: { reason: "rate_limited"|"concurrency_limited"|"upstream_rate_limited" }) => void,
 * }} [options]
 *   `timeouts` — nadpisanie timeoutów LLM (testy/serwer); null = wyłączony (tenant: 55 s / 180 s).
 *   `tenant` — konfiguracja z rejestru (lib/tenants): CORS, locale, limity, kolekcja, model,
 *   prompt, tagi trace'u. Bez `tenant` handler zachowuje się jak przed wielodostępnością (env).
 *   `llmClient` — klient OpenAI-compatible zbudowany z sekretów tenanta (klucz per tenant).
 */
export function createDocsChatHandler(options = {}) {
  const env = options.env || process.env;
  const checkRateLimit = options.checkRateLimit || checkDocsChatRateLimit;
  const retrieveContext = options.retrieveContext || retrieveDocsChatContext;
  const streamCompletion =
    options.streamCompletion || streamDocsChatCompletion;
  const langfuseService = options.langfuseService;
  const generateTraceId = options.generateTraceId || uuidv4;
  // odrzuty limitera lecą jako SSE w HTTP 200 — bez tego hooka metryki HTTP ich nie widzą
  const onRejection = options.onRejection || (() => {});
  // limity ochronne z rejestru tenanta (ścieżka legacy bez tenanta: bezpieczne domyślne)
  const tenantLimits = {
    perIpDaily: options.tenant?.limits?.perIpDaily ?? null,
    maxOutputTokens: options.tenant?.limits?.maxOutputTokens ?? 1500,
    maxConcurrentPerIp: options.tenant?.limits?.maxConcurrentPerIp ?? 5,
  };
  // semafor per IP (per proces/replikę): jeden adres nie może trzymać dziesiątek otwartych
  // generacji po 180 s. Sufit dla całego tenanta trzyma limit równoległości jego klucza LLM w proxy.
  /** @type {Map<string, number>} */
  const inFlightByIp = new Map();
  const policy = resolvePolicy({
    tenant: options.tenant,
    llmClient: options.llmClient,
    env,
    timeouts: options.timeouts,
  });

  /**
   * @param {any} req
   * @param {any} res
   */
  return async function docsChatHandler(req, res) {
    const cors = policy.cors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (!cors.allowed) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST", "OPTIONS"]);
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let request;
    try {
      request = validateDocsChatRequest(req.body || {}, policy.localePolicy);
    } catch (error) {
      startSse(res);
      sendSseError(res, "invalid_request", error instanceof Error ? error.message : String(error));
      return;
    }
    // traceId generowany zawsze (logi), ale do klienta w `done` idzie TYLKO gdy obserwowalność
    // działa — bez Langfuse nie ma czego oceniać kciukami, więc klient chowa feedback (E1c → korekta
    // po produkcyjnym „Nie udało się zapisać opinii" przy wyłączonym Langfuse).
    // createTrace poza try walidacji: błąd Langfuse nie może udawać invalid_request.
    const traceId = generateTraceId();
    const observable = isObservable(langfuseService);
    const trace = langfuseService
      ? langfuseService.createTrace(
          policy.traceTags
            ? { id: traceId, name: "DocsChat", sessionId: traceId, tags: policy.traceTags }
            : { id: traceId, name: "DocsChat", sessionId: traceId }
        )
      : null;

    // Obserwowalność nigdy nie może wpłynąć na odpowiedź: finalizacja dokładnie raz,
    // nierzucająca, i zawsze PO ramce błędu/`end()` (wyjątek z Langfuse po `end()` skończyłby
    // się write-after-end przez fallback Next „Internal Server Error").
    let finalized = false;
    let slotHeld = false;
    /** @type {string|null} */
    let slotIp = null;
    const releaseSlot = () => {
      if (slotHeld) {
        slotHeld = false;
        if (slotIp !== null) {
          const left = (inFlightByIp.get(slotIp) ?? 1) - 1;
          if (left <= 0) inFlightByIp.delete(slotIp);
          else inFlightByIp.set(slotIp, left);
        }
      }
    };
    res.once?.("close", releaseSlot);
    /**
     * @param {Array<{ role: string, content: string }>} output
     * @param {Record<string, unknown>} [metadata]
     */
    const finalizeOnce = async (output, metadata) => {
      releaseSlot();
      if (finalized) return;
      finalized = true;
      try {
        await finalizeTrace(langfuseService, trace, request, output, metadata);
      } catch (observabilityError) {
        console.warn(
          "Docs chat: Langfuse finalization failed:",
          observabilityError instanceof Error ? observabilityError.message : observabilityError
        );
      }
    };
    // ścieżka legacy: dokładnie te klucze (kontrakt testów); tenant: + tenant, client, model
    // id żądania z gatewaya (X-Request-ID llmproxy) = klucz korelacji z eventami billingowymi
    /** @type {string|null} */
    let llmRequestId = null;
    /** @type {boolean|null} oznaczenie AI Act z gatewaya (X-AI-Generated) — propagowane w `done` */
    let llmAiGenerated = null;
    const baseMetadata = () => ({
      ...(policy.tenantId
        ? { tenant: policy.tenantId, client: request.client, model: policy.model }
        : {}),
      ...(llmRequestId ? { llmRequestId } : {}),
      scope: request.scope,
      locale: request.locale,
      route: request.page?.route,
      sourceFilePath: request.page?.sourceFilePath,
    });

    // fullContent/objects nad try — catch/abort muszą widzieć częściową odpowiedź i liczbę źródeł
    let fullContent = "";
    /** @type {any[]} */
    let objects = [];
    /** @type {import("../chat/sse.mjs").SseSource[]} */
    let sources = [];
    /** źródła do trace'u (tenant): tytuł/trasa/score — bez treści fragmentów */
    const sourcesMetadata = () =>
      policy.tenantId
        ? { sources: sources.map(({ title, route, score }) => ({ title, route, score })) }
        : {};
    /** krok „w toku" — przy błędzie serwer zamyka go jako failed (autorytatywnie) */
    /** @type {"retrieve"|"answer"|null} */
    let runningStep = null;
    // abort podpięty przed pracą asynchroniczną (limiter, retrieval, LLM)
    const abort = attachAbort(res);
    /**
     * Wspólne wyjście dla zerwania klienta: bez ramek, częściowa odpowiedź do trace'u.
     * @param {string} phase
     */
    const abortedExit = async (phase) => {
      console.info(`Docs chat: client aborted ${phase} (trace ${traceId}, ${fullContent.length} chars)`);
      endSse(res);
      await finalizeOnce(fullContent ? [{ role: "assistant", content: fullContent }] : [], {
        ...baseMetadata(),
        ...sourcesMetadata(),
        retrievedSourceCount: objects.length,
        aborted: true,
      });
    };

    try {
      const clientIp = getClientIp(req, env);
      const rateLimit = await checkRateLimit(policy.rateLimitInput(clientIp));
      // drugi bucket: dobowy per IP — sufit kosztu dnia z jednego adresu;
      // liczony DOPIERO gdy okno krótkie przepuściło — inaczej odrzuty z limitu 10-minutowego
      // spalałyby limit dobowy całego biura za jednym NAT-em
      const dailyLimit =
        rateLimit.allowed && tenantLimits.perIpDaily
          ? await checkRateLimit({ clientIp: `daily:${options.tenant?.id ?? "legacy"}:${clientIp}`, maxRequests: tenantLimits.perIpDaily, windowSeconds: 86_400 })
          : { allowed: true };

      startSse(res);

      if (!rateLimit.allowed || !dailyLimit.allowed) {
        onRejection({ reason: "rate_limited" });
        sendSseError(
          res,
          "rate_limited",
          "Too many requests. Please try again later."
        );
        await finalizeOnce([], {
          ...baseMetadata(),
          retrievedSourceCount: 0,
          errorCode: "rate_limited",
        });
        return;
      }

      // slot zwalnia finalizeOnce (także przy zerwaniu połączenia — `close`)
      const ipInFlight = inFlightByIp.get(clientIp) ?? 0;
      if (ipInFlight >= tenantLimits.maxConcurrentPerIp) {
        onRejection({ reason: "concurrency_limited" });
        sendSseError(res, "rate_limited", "The assistant is busy right now. Please try again in a moment.");
        await finalizeOnce([], { ...baseMetadata(), retrievedSourceCount: 0, errorCode: "concurrency_limited" });
        return;
      }
      inFlightByIp.set(clientIp, ipInFlight + 1);
      slotHeld = true;
      slotIp = clientIp;

      if (abort.signal.aborted) {
        // klient zerwał, gdy limiter jeszcze pracował — nie liczymy embeddingu ani retrievalu
        await abortedExit("before retrieval");
        return;
      }

      // step: obowiązkowe (plan §4.2) — domyślny model nie emituje `reasoning`,
      // więc bez kroków ślad w UI byłby pusty. Serwer jest autorytatywny także dla `failed`.
      runningStep = "retrieve";
      writeSse(res, { type: "step", id: "retrieve", status: "running" });
      // jeden filtr „bez tekstu" PRZED numeracją: indeksy `sources` == numery `[n]` w kontekście
      objects = filterUsableObjects(await retrieveContext(request, { ...policy.retrievalOptions, signal: abort.signal }));
      if (objects.length === 0) {
        runningStep = null;
        writeSse(res, { type: "step", id: "retrieve", status: "failed" });
        sendSseError(
          res,
          "no_context",
          request.scope === "page"
            ? "No relevant context found for this page."
            : "No relevant context found in the documentation."
        );
        await finalizeOnce([], {
          ...baseMetadata(),
          retrievedSourceCount: 0,
          errorCode: "no_context",
        });
        return;
      }

      sources = buildSources(objects);
      writeSse(res, { type: "sources", sources });
      runningStep = null;
      writeSse(res, {
        type: "step",
        id: "retrieve",
        status: "done",
        meta: { count: sources.length },
      });

      if (abort.signal.aborted) {
        // klient zerwał w fazie retrievalu — nie wołamy modelu
        await abortedExit("before LLM call");
        return;
      }

      runningStep = "answer";
      // meta.model: klient docs pokazuje chip modelu tylko, gdy serwer go poda (plan §7)
      writeSse(res, { type: "step", id: "answer", status: "running", meta: { model: policy.model } });
      const contextText = buildContextText(objects);
      // Sygnał do LLM = zerwanie klienta LUB timeout serwerowy (pierwszy token / całość).
      // Kontroler pochodny: `abort.signal` zostaje czystym „klient zerwał" (decyduje o abortedExit).
      const llmAbort = new AbortController();
      const onClientAbort = () => llmAbort.abort();
      abort.signal.addEventListener("abort", onClientAbort, { once: true });
      if (abort.signal.aborted) llmAbort.abort();
      /** @type {"first_token"|"total"|null} */
      let timedOut = null;
      /** @type {NodeJS.Timeout[]} */
      const timers = [];
      /** @type {NodeJS.Timeout|null} */
      let firstTokenTimer = null;
      if (policy.timeouts.totalMs) {
        timers.push(setTimeout(() => { timedOut = timedOut || "total"; llmAbort.abort(); }, policy.timeouts.totalMs));
      }
      if (policy.timeouts.firstTokenMs) {
        firstTokenTimer = setTimeout(() => { timedOut = timedOut || "first_token"; llmAbort.abort(); }, policy.timeouts.firstTokenMs);
        timers.push(firstTokenTimer);
      }
      const clearTimers = () => {
        timers.forEach((timer) => clearTimeout(timer));
        abort.signal.removeEventListener("abort", onClientAbort);
      };
      /** timeout modelu: krok failed + llm_error z jasnym komunikatem; częściowa odpowiedź do trace'u */
      const timedOutExit = async () => {
        runningStep = null;
        writeSse(res, { type: "step", id: "answer", status: "failed" });
        sendSseError(
          res,
          "llm_error",
          timedOut === "first_token"
            ? "The model did not start answering in time. Please try again."
            : "The answer took too long and was cut off. Please try again."
        );
        await finalizeOnce(fullContent ? [{ role: "assistant", content: fullContent }] : [], {
          ...baseMetadata(),
          ...sourcesMetadata(),
          retrievedSourceCount: objects.length,
          errorCode: "llm_timeout",
          timeout: timedOut,
        });
      };

      try {
        for await (const delta of streamCompletion(
          {
            prompt: request.prompt,
            contextText,
            locale: request.locale,
            promptText: policy.retrievalOptions.tenant?.promptText ?? policy.promptText, // live: admin API podmienia tenant.promptText w locie (fallback = kopia z resolvePolicy dla ścieżki legacy)
            persona: policy.persona,
            sources,
          },
          {
            signal: llmAbort.signal,
            maxTokens: tenantLimits.maxOutputTokens,
            onResponse: (/** @type {{ requestId: string|null, aiGenerated: boolean }} */ meta) => {
              llmRequestId = meta.requestId;
              llmAiGenerated = meta.aiGenerated;
            },
            ...policy.llmOptions,
          }
        )) {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          if (llmAbort.signal.aborted) {
            // po abort SDK może dosłać bufor — nie piszemy do klienta ani do odpowiedzi
            break;
          }
          if (delta.type === "reasoning") {
            // Forward thinking tokens so the client's inactivity timer keeps
            // resetting during the long reasoning phase; reasoning is shown to
            // the user but is not part of the recorded answer.
            writeSse(res, { type: "reasoning", content: delta.content });
            continue;
          }

          if (delta.type === "content") {
            fullContent += delta.content;
            writeSse(res, { type: "content", content: delta.content });
          }
        }
      } catch (error) {
        clearTimers();
        // timeout przed pierwszym tokenem: SDK rzuca APIUserAbortError na nasz sygnał — to nie
        // błąd upstreamu, tylko nasz limit; zerwanie klienta obsługuje zewnętrzny catch.
        if (timedOut && !abort.signal.aborted) {
          await timedOutExit();
          return;
        }
        throw error;
      }
      clearTimers();

      // Abort w trakcie strumienia NIE rzuca (SDK połyka AbortError) — sprawdzamy jawnie.
      if (abort.signal.aborted) {
        await abortedExit("stream");
        return;
      }
      if (timedOut) {
        await timedOutExit();
        return;
      }

      // kolejność: done → end → finalizacja obserwowalności (klient nie czeka na Langfuse)
      runningStep = null;
      writeSse(res, { type: "step", id: "answer", status: "done" });
      writeSse(res, {
        type: "done",
        traceId: observable ? traceId : null,
        // AI Act art. 50(2)/(4): maszynowe oznaczenie treści wygenerowanej — pole addytywne
        ...(llmAiGenerated === true ? { aiGenerated: true } : {}),
      });
      endSse(res);
      await finalizeOnce([{ role: "assistant", content: fullContent }], {
        ...baseMetadata(),
        ...sourcesMetadata(),
        retrievedSourceCount: objects.length,
      });
      return;
    } catch (error) {
      if (abort.signal.aborted) {
        // abort przed pierwszą odpowiedzią modelu → SDK rzuca APIUserAbortError; to nie błąd.
        // Inny wyjątek zbiegły z zerwaniem — logujemy, żeby nie zginął.
        if (!(error instanceof Error) || error.name !== "APIUserAbortError") {
          console.warn(
            "Docs chat: error during aborted request:",
            error instanceof Error ? error.message : error
          );
        }
        await abortedExit("before first token");
        return;
      }
      // status HTTP z gatewaya (openai SDK: APIError.status): 429 = limit rpm/concurrency KLUCZA
      // tenanta po stronie llmproxy (użytkownik ma dostać „zajęty", nie „awaria"); 401/403 = klucz
      // wygasł/cofnięty — to alarm dla operatora, nie dla użytkownika
      const upstreamStatus = Number(/** @type {any} */ (error)?.status ?? /** @type {any} */ (error)?.response?.status ?? 0);
      const upstreamErrorCode =
        upstreamStatus === 429 ? "upstream_rate_limited" : upstreamStatus === 401 || upstreamStatus === 403 ? "upstream_auth" : "llm_error";
      const upstreamRequestId = /** @type {any} */ (error)?.headers?.["x-request-id"] ?? null; // llmproxy stawia X-Request-ID też na błędach
      if (upstreamRequestId) llmRequestId = upstreamRequestId;
      console.error(
        upstreamErrorCode === "upstream_auth"
          ? "Docs chat API error: LLM gateway returned 401/403 — tenant key expired/revoked OR unknown model name (llmproxy answers 401 for both) —"
          : "Docs chat API error:",
        error instanceof Error ? error.message : String(error),
        `(trace ${traceId})`, // ten sam id widzi użytkownik w ramce done / feedbacku — korelacja zgłoszenia z logiem
        upstreamRequestId ? `(gateway request ${upstreamRequestId})` : ""
      );
      if (!res.headersSent && !res.writableEnded) {
        startSse(res);
      }
      // krok w toku → failed (serwer autorytatywny)
      if (runningStep) {
        writeSse(res, { type: "step", id: runningStep, status: "failed" });
      }
      if (upstreamErrorCode === "upstream_rate_limited") {
        onRejection({ reason: "upstream_rate_limited" });
        sendSseError(res, "rate_limited", "The assistant is busy right now. Please try again in a moment.");
      } else {
        sendSseError(res, "llm_error", policy.llmErrorMessage);
      }
      await finalizeOnce([], {
        ...baseMetadata(),
        ...sourcesMetadata(),
        retrievedSourceCount: objects.length,
        errorCode: upstreamErrorCode,
      });
      return;
    }
  };
}
