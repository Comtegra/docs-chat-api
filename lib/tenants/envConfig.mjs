// @ts-check
// Konfiguracja instancji = CZYSTY ENV (tenant.json odchodzi — plan env-config-refactor).
// envConfig buduje definicję JEDYNEGO tenanta z env + defaultów i waliduje ją na miejscu
// (validateTenantConfig, fail-closed jak dotąd; createTenantRegistry waliduje drugi raz,
// bez skutków ubocznych). Klient ustawia w prod: DATABASE_URL + OPENAI_API_KEY
// (+ opcjonalnie DOCS_CHAT_LOCALES/MODEL/CORS_ORIGINS) — reszta ma defaulty.
//
// Prompt: plik (default /app/tenant/prompt.md) — brak pliku = tworzony z neutralnej bazy
// przy pierwszym boocie, żeby PUT /api/v1/admin/prompt działał od razu; wolumen = persist
// persony przez recreate. Jawnie podany DOCS_CHAT_PROMPT_FILE z nieczytelnym plikiem =
// fail-closed (błąd startu). Awaria zapisu pliku DEFAULTOWEGO (np. read-only fs) = warn +
// prompt z kodu — boot nie pada przez prompt defaultowy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildDefaultPromptFileText } from "../docsChat/prompts/base.mjs";
import { boolFromEnv, numberFromEnv, positiveIntegerFromEnv, splitList } from "./env.mjs";
import { personaFromEnv } from "./persona.mjs";
import { DEFAULT_PROMPT_FILE_PATH, readPromptFile } from "./promptFile.mjs";
import { validateTenantConfig } from "./registry.mjs";

// DEFAULT_PROMPT_FILE_PATH zyje w promptFile.mjs (jedno zrodlo prawdy dla sciezki promptu);
// re-eksport dla wygody importow (testy, przyszli konsumenci).
export { DEFAULT_PROMPT_FILE_PATH } from "./promptFile.mjs";

/** Defaulty zgodne z plan env-config-refactor (internal env) — konwencja Comtegra: pl-first. */
const DEFAULT_LOCALES = ["pl"];
const DEFAULT_MODEL = "gemma-4-26b-a4b";

/**
 * Prompt instancji: ścieżka z env albo default; plik istnieje → czytamy (fail-closed
 * walidacja), brak → tworzymy z neutralnej bazy i czytamy. Zwraca ścieżkę + tekst:
 * ścieżka trafia do tenant.promptFile (admin API pisze dokładnie tam, gdzie start czytał).
 * @param {Record<string, string|undefined>} env
 * @param {{ warn: (message: string) => void, defaultPromptFile?: string }} options
 * @returns {{ path: string, text: string|undefined }}
 */
function resolvePrompt(env, options) {
  const explicit = String(env.DOCS_CHAT_PROMPT_FILE || "").trim();
  const path = explicit || options.defaultPromptFile || DEFAULT_PROMPT_FILE_PATH;
  if (explicit) {
    // jawna konfiguracja: zły plik zatrzymuje start (fail-closed, jak dotąd)
    return { path, text: readPromptFile(path, "DOCS_CHAT_PROMPT_FILE") };
  }
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buildDefaultPromptFileText() + "\n", "utf8");
    }
    return { path, text: readPromptFile(path, "DOCS_CHAT_PROMPT_FILE") };
  } catch (/** @type {any} */ error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warn(
      `prompt file: cannot ensure the default prompt file "${path}" (${message}) — ` +
        "prompt falls back to the code base; PUT /api/v1/admin/prompt will report the write error until the path is writable"
    );
    // ścieżka niesiona dalej (tenant.promptFile) — admin PUT spróbuje pisać i odda uczciwy błąd
    return { path, text: undefined };
  }
}

/**
 * Definicja jedynego tenanta z env + defaultów, zwalidowana (fail-closed: zły env = throw).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ warn?: (message: string) => void, defaultPromptFile?: string }} [options]
 * @returns {import("./registry.mjs").TenantConfig}
 */
export function tenantConfigFromEnv(env = process.env, options = {}) {
  const warn = options.warn || (() => {});
  const locales = splitList(env.DOCS_CHAT_LOCALES, DEFAULT_LOCALES).map((locale) =>
    locale.toLowerCase()
  );
  const config = {
    id: "docs",
    name: (env.DOCS_CHAT_NAME || "Docs Chat").trim(),
    organization: (env.DOCS_CHAT_ORGANIZATION || "Docs Chat").trim(),
    siteUrl: (env.DOCS_CHAT_SITE_URL || "").trim().replace(/\/+$/, ""),
    locales,
    defaultLocale: locales[0],
    // kolekcje auto: docs-<locale> (nazwa to detal wdrożenia; import i tak buduje indeks od zera)
    collections: Object.fromEntries(locales.map((locale) => [locale, `docs-${locale}`])),
    cors: { origins: splitList(env.DOCS_CHAT_CORS_ORIGINS, ["*"]) },
    limits: {
      perIp: {
        max: positiveIntegerFromEnv(env.DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS, 20),
        windowSeconds: positiveIntegerFromEnv(env.DOCS_CHAT_RATE_LIMIT_WINDOW_SECONDS, 600),
      },
      perIpDaily: positiveIntegerFromEnv(env.DOCS_CHAT_PER_IP_DAILY_LIMIT, 200),
      maxConcurrentPerIp: positiveIntegerFromEnv(env.DOCS_CHAT_MAX_CONCURRENT_PER_IP, 5),
      maxOutputTokens: positiveIntegerFromEnv(env.DOCS_CHAT_MAX_OUTPUT_TOKENS, 1500),
    },
    model: (env.DOCS_CHAT_MODEL || env.CHAT_MODEL || DEFAULT_MODEL).trim(),
    retrieval: {
      vectorWeight: numberFromEnv(env.DOCS_CHAT_RETRIEVAL_VECTOR_WEIGHT, 0.3),
      textWeight: numberFromEnv(env.DOCS_CHAT_RETRIEVAL_TEXT_WEIGHT, 0.7),
      limit: positiveIntegerFromEnv(env.DOCS_CHAT_RETRIEVAL_LIMIT, 5),
    },
    llm: { requireOwnKey: boolFromEnv(env.DOCS_CHAT_LLM_REQUIRE_OWN_KEY, false) },
    auth: { requireSiteToken: boolFromEnv(env.DOCS_CHAT_AUTH_REQUIRE_SITE_TOKEN, false) },
    langfuse: { enabled: boolFromEnv(env.LANGFUSE_ENABLED, false), project: "own" },
    ...(() => {
      const prompt = resolvePrompt(env, { warn, defaultPromptFile: options.defaultPromptFile });
      return { promptFile: prompt.path, promptText: prompt.text };
    })(),
    persona: personaFromEnv(env),
  };
  return validateTenantConfig(config);
}
