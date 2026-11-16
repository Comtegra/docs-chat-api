// @ts-check
// Obserwowalność (Langfuse) — jedna klasa dla site-chatu, docs-chatu i serwisu docs-chat-api.
// Przeniesione z LangfuseService.ts na .mjs + JSDoc (jak reszta lib/): serwis API działa
// w czystym Node bez transpilacji, a reguła „fabryki nie importują .ts" przestaje być potrzebna.
//
// Konstruktor bez argumentu = globalne LANGFUSE_* (jeden projekt, ścieżka legacy).
// Z argumentem = projekt per tenant (lib/tenants/registry.mjs → resolveTenantSecrets);
// serwis API trzyma Map<tenantId, LangfuseService>.

import { Langfuse } from "langfuse";

import { getLangfuseConfig, normalizeLangfuseCompletion } from "../langfuseConfig.mjs";

/** @typedef {import("langfuse").LangfuseTraceClient} LangfuseTraceClient */
/** @typedef {import("langfuse").LangfuseSpanClient} LangfuseSpanClient */
/** @typedef {import("langfuse").LangfuseGenerationClient} LangfuseGenerationClient */
/** @typedef {import("openai/resources/chat/completions").ChatCompletionMessageParam} ChatCompletionMessageParam */

/**
 * @typedef {{ enabled: false } | { enabled: true, baseUrl: string, publicKey: string, secretKey: string, requestTimeoutMs?: number }} LangfuseServiceConfig
 */

/**
 * @typedef {Object} LangfuseCompletionPayload
 * @property {Array<{ message?: unknown }>} [choices]
 * @property {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} [usage]
 */

export class LangfuseService {
  /** @type {Langfuse|null} */
  langfuse = null;

  /**
   * @param {LangfuseServiceConfig} [config]
   */
  constructor(config = getLangfuseConfig(process.env)) {
    if (!config.enabled) {
      return;
    }

    this.langfuse = new Langfuse({
      secretKey: config.secretKey,
      publicKey: config.publicKey,
      baseUrl: config.baseUrl,
      fetchRetryCount: 0,
      requestTimeout: config.requestTimeoutMs ?? Number(process.env.LANGFUSE_REQUEST_TIMEOUT_MS || 1000),
    });
    this.langfuse.on("error", (/** @type {Error} */ error) => {
      console.error("Langfuse error:", error);
    });

    if (process.env.NODE_ENV === "development") {
      this.langfuse.debug();
    }
  }

  /**
   * @param {{ id: string, name: string, sessionId: string, tags?: string[], metadata?: Record<string, unknown> }} options
   * @returns {LangfuseTraceClient|null}
   */
  createTrace(options) {
    if (!this.langfuse) {
      return null;
    }

    return this.langfuse.trace(options);
  }

  /**
   * @param {LangfuseTraceClient|null} trace
   * @param {string} name
   * @param {unknown} [input]
   * @returns {LangfuseSpanClient|null}
   */
  createSpan(trace, name, input) {
    if (!trace) {
      return null;
    }

    return trace.span({
      name,
      input: input ? JSON.stringify(input) : undefined,
    });
  }

  /**
   * @param {LangfuseSpanClient|null} span
   * @param {string} name
   * @param {string} model
   * @param {ChatCompletionMessageParam[]} input
   * @param {LangfuseCompletionPayload} output
   * @param {number} [promptTokens]
   * @param {number} [completionTokens]
   * @param {number} [totalTokens]
   */
  finalizeSpan(span, name, model, input, output, promptTokens = 0, completionTokens = 0, totalTokens = 0) {
    if (!span) {
      return;
    }

    const normalizedOutput = /** @type {LangfuseCompletionPayload} */ (normalizeLangfuseCompletion(output));
    const message = normalizedOutput.choices?.[0]?.message || {};

    span.update({
      name,
      output: JSON.stringify(message),
    });

    /** @type {LangfuseGenerationClient} */
    const generation = span.generation({
      name,
      model,
      modelParameters: {
        temperature: 0.7,
      },
      input,
      output: normalizedOutput,
      usage: {
        promptTokens: normalizedOutput.usage?.prompt_tokens || promptTokens,
        completionTokens: normalizedOutput.usage?.completion_tokens || completionTokens,
        totalTokens: normalizedOutput.usage?.total_tokens || totalTokens,
      },
    });
    generation.end();
    span.end();
  }

  /**
   * @param {LangfuseTraceClient|null} trace
   * @param {ChatCompletionMessageParam[]|string} originalMessages
   * @param {ChatCompletionMessageParam[]} generatedMessages
   * @param {Record<string, unknown>} [metadata]
   */
  async finalizeTrace(trace, originalMessages, generatedMessages, metadata) {
    if (!this.langfuse || !trace) {
      return;
    }

    trace.update({
      input: JSON.stringify(originalMessages),
      output: JSON.stringify(generatedMessages),
      metadata,
    });
    this.langfuse.flushAsync().catch((/** @type {Error} */ error) => {
      console.warn("Langfuse flush failed:", error.message);
    });
  }

  /** Czy obserwowalność jest skonfigurowana (bez kluczy Langfuse wszystkie metody są no-op). */
  get enabled() {
    return this.langfuse !== null;
  }

  /**
   * Ocena użytkownika (kciuk w górę/w dół) dla trace'u — feedback z UI czatów
   * (plan docs/ai-native-ui-plan.md §4.2, E1c). Deterministyczne `id` = upsert po stronie
   * Langfuse: ponowne kliknięcie nadpisuje, nie dubluje. Sam enqueue (sync); flush osobno.
   * @param {{ traceId: string, name: string, value: number, id?: string, comment?: string }} input
   * @returns {boolean} true gdy score został zakolejkowany, false gdy Langfuse wyłączony
   */
  score(input) {
    if (!this.langfuse) {
      return false;
    }

    this.langfuse.score({
      id: input.id,
      traceId: input.traceId,
      name: input.name,
      value: input.value,
      comment: input.comment,
    });
    return true;
  }

  /**
   * Wysyła zakolejkowane eventy i RZUCA, gdy wysyłka się nie powiodła.
   * SDK (`langfuse-core` 3.37) `flushAsync()` „always resolves, even if there were errors":
   * błąd HTTP/sieci/timeoutu idzie w event `warning`, batch jest porzucany — bez nasłuchu
   * `200 {stored:true}` byłoby kłamstwem. Nasłuch tylko na czas flusha (współbieżny
   * fire-and-forget flush z finalizeTrace może dać fałszywy negatyw → 202, akceptowalne).
   */
  async flushAsync() {
    if (!this.langfuse) {
      return;
    }

    /** @type {unknown} */
    let failure = null;
    const unsubscribe = this.langfuse.on("warning", (/** @type {unknown} */ event) => {
      failure = event;
    });
    try {
      await this.langfuse.flushAsync();
    } finally {
      unsubscribe();
    }
    if (failure) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
  }

  /** Flush + zamknięcie klienta — wołane przy SIGTERM serwisu API, żeby nie gubić trace'ów. */
  async shutdownAsync() {
    if (!this.langfuse) {
      return;
    }

    await this.langfuse.shutdownAsync();
  }
}
