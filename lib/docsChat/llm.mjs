// @ts-check
import OpenAI from "openai";

import { CHAT_MODEL } from "../chat/model.mjs";
import { buildBaseSystemPrompt } from "./prompts/base.mjs";
import { buildPersonaSystemPrompt } from "./prompts/framework.mjs";

/**
 * A single streamed delta from the model.
 *
 * Reasoning models (e.g. qwen35-122b) stream their chain-of-thought — vLLM
 * exposes it as `delta.reasoning`, some other servers use
 * `delta.reasoning_content` — for many seconds *before* the answer starts
 * arriving in `delta.content`. We surface both as distinct, tagged deltas so
 * the transport never goes silent during that thinking phase.
 *
 * @typedef {{ type: "reasoning" | "content", content: string }} DocsChatDelta
 */

/**
 * Klient OpenAI-compatible (vLLM przez llm.comtegra.cloud). Serwer wielodostępny buduje
 * klienta per tenant (klucz per tenant = rozliczalność kosztów) i podaje go w `options.client`.
 * @param {Record<string, string|undefined>} [env]
 */
export function createLlmClient(env = process.env) {
  return new OpenAI({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
    // bez retry SDK: llmproxy odpowiada 429 natychmiast (rpm/concurrency klucza), a ponowienia
    // mnożyłyby obciążenie limitu i zjadały budżet pierwszego tokenu; retry = decyzja użytkownika
    maxRetries: 0,
  });
}

/**
 * Weryfikacja przy starcie: czy gateway (llmproxy) serwuje modele, których tenant używa.
 * llmproxy na NIEZNANY model odpowiada 401 „Incorrect model" — tak samo jak na zły klucz — więc
 * literówka w nazwie modelu w runtime wyglądałaby jak wygasły klucz. Nie blokuje startu
 * (gateway może być chwilowo niedostępny) — zwraca listę braków do zalogowania.
 * @param {{ client: any, expected: string[] }} input
 * @returns {Promise<{ available: string[], missing: string[] }>}
 */
export async function verifyGatewayModels({ client, expected }) {
  const list = await client.models.list({ timeout: 10_000, maxRetries: 0 }); // czarna dziura sieciowa ≠ 10 min wiszenia
  /** @type {string[]} */
  const available = [];
  const data = Array.isArray(list?.data) ? list.data : [];
  for (const entry of data) {
    if (entry && typeof entry.id === "string") available.push(entry.id);
  }
  const missing = expected.filter((model) => !available.includes(model));
  return { available, missing };
}

/**
 * System prompt tenanta. Wszystko per tenant to dane deployu; kod wozi wyłącznie reguły:
 * - `promptText` (DOCS_CHAT_PROMPT_FILE) — pełna podmiana treści promptu (np. wdrożenie
 *   domowe `ask` z regułami produktowymi); opcjonalna persona doklejona z przodu jako warstwa
 *   tonu; blok <docs_context> dokłada silnik (EN, paritet z prod promptem ask);
 * - `persona` (DOCS_CHAT_PERSONA_FILE) — framework (prompts/framework.mjs) składa
 *   niemodyfikowalne reguły groundingowe + personę z deployu (spike per-tenant deploy);
 * - bez obu — neutralna baza z kodu (prompts/base.mjs): asystent dokumentacji bez treści produktowych.
 * @param {{ contextText: string, locale: string, promptText?: string|null, persona?: string|null }} input
 */
export function buildSystemPrompt({ contextText, locale, promptText, persona }) {
  if (promptText) {
    const head = persona ? `${persona}\n\n${promptText}` : promptText;
    return `${head}\n\nDocumentation context:\n<docs_context>\n${contextText}\n</docs_context>`;
  }
  if (persona) {
    return buildPersonaSystemPrompt({ persona, contextText });
  }
  return buildBaseSystemPrompt({ contextText, locale });
}

/**
 * Model docs-chatu: `DOCS_CHAT_MODEL` nadpisuje wspólny `CHAT_MODEL`. Eksportowane, żeby
 * handler mógł podać nazwę modelu w `step answer running` (`meta.model` → chip modelu w UI docs).
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveDocsChatModel(env = process.env) {
  return env.DOCS_CHAT_MODEL || CHAT_MODEL;
}

/**
 * Streams the documentation answer as a sequence of tagged deltas.
 *
 * @param {{ prompt: string, contextText: string, locale: string, promptText?: string|null, persona?: string|null, sources?: unknown[] }} input
 * @param {{ env?: Record<string, string|undefined>, client?: any, model?: string, signal?: AbortSignal, maxTokens?: number, onResponse?: (meta: { requestId: string|null, aiGenerated: boolean }) => void }} [options]
 *   `onResponse` — nagłówki odpowiedzi gatewaya: `X-Request-ID` (korelacja z billingiem llmproxy),
 *   `X-AI-Generated` (oznaczenie AI Act; dla SSE proxy daje tylko nagłówek, body bajt-w-bajt)
 *   `model` — model tenanta (rejestr); bez niego DOCS_CHAT_MODEL/CHAT_MODEL z env (tenant cgc).
 *   `signal` — z sseWriter.attachAbort: zerwanie klienta przerywa strumień po stronie LLM
 *   (bez tego Stop w UI mnożyłby koszt). Uwaga: abort W TRAKCIE strumienia nie rzuca — SDK
 *   kończy iterator „normalnie"; konsument sprawdza `signal.aborted` po pętli.
 * @returns {AsyncGenerator<DocsChatDelta>}
 */
export async function* streamDocsChatCompletion(input, options = {}) {
  const env = options.env || process.env;
  const client = options.client || createLlmClient(env);
  const model = options.model || resolveDocsChatModel(env);
  const created = client.chat.completions.create(
    {
      model,
      stream: true,
      // twardy sufit odpowiedzi — bez niego jedyną granicą był timeout 180 s (koszt + zajęty slot)
      max_tokens: options.maxTokens ?? 1500,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(input),
        },
        {
          role: "user",
          content: input.prompt,
        },
      ],
    },
    { signal: options.signal }
  );
  // openai SDK: APIPromise.withResponse() daje nagłówki; mocki/inne klienty — zwykła obietnica
  let completion;
  if (typeof created.withResponse === "function") {
    const { data, response } = await created.withResponse();
    completion = data;
    options.onResponse?.({
      requestId: response?.headers?.get?.("x-request-id") ?? null,
      aiGenerated: response?.headers?.get?.("x-ai-generated") === "true",
    });
  } else {
    completion = await created;
  }

  for await (const chunk of completion) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) {
      continue;
    }

    // Thinking tokens arrive first; emit them so downstream consumers can keep
    // the connection alive and show progress while the answer is still forming.
    // vLLM streams them as `delta.reasoning`; accept `reasoning_content` too.
    const reasoning = delta.reasoning || delta.reasoning_content;
    if (reasoning) {
      yield { type: "reasoning", content: reasoning };
    }

    if (delta.content) {
      yield { type: "content", content: delta.content };
    }
  }
}
