// @ts-check
// Prompt instancji z zewnątrz (dane deployu): DOCS_CHAT_PROMPT_FILE wskazuje plik
// z PEŁNYM system promptem (bez bloku kontekstu — <docs_context> dokłada silnik).
// Default ścieżki (envConfig, bez jawnej zmiennej): /app/tenant/prompt.md — brak pliku =
// tworzony z neutralnej bazy przy pierwszym boocie, żeby admin API działał od razu.
//
// Admin API (PUT /api/v1/admin/prompt, Bearer klucz indeksu) używa tych samych
// walidatorów do podmiany pliku w locie: walidacja PRZED zapisem (zły prompt nigdy
// nie nadpisuje działającego pliku), zapis do tenant.promptFile (ścieżka rozwiązana przy
// starcie — admin pisze DOKŁADNIE tam, gdzie start czytał) + live-apply w pamięci,
// restart ładuje ten sam plik. 409 tylko dla tenantów bez pliku promptu (inline w testach).

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

/** Górny sufit promptu z pliku: chroni przed przypadkowo podłożonym plikiem (np. całym podręcznikiem). */
export const PROMPT_MAX_CHARS = 8000;

/** Default pliku promptu: punkt montażania wolumenu instancji (-v <vol> -fp /app/tenant). */
export const DEFAULT_PROMPT_FILE_PATH = "/app/tenant/prompt.md";

/**
 * Plik promptu nie jest skonfigurowany (endpoint admina odpowiada wtedy 409) — tenant
 * inline bez promptFile; env-config tenant (prod) niesie ścieżkę zawsze.
 */
export class PromptFileNotConfiguredError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PromptFileNotConfiguredError";
  }
}

/**
 * Walidacja treści promptu — wspólna dla startu i admin API (fail-closed, jedno miejsce prawdy).
 * @param {string} raw  treść promptu (raw, trimowana tutaj)
 * @param {string} [source]  opis pochodzenia do komunikatów błędów (np. nazwa zmiennej env)
 * @returns {string}  przycięty, zwalidowany tekst promptu
 * @throws {Error}  pusty, za długi albo domyka cudzy blok </docs_context>
 */
export function validatePromptText(raw, source = "prompt") {
  const promptText = String(raw || "").trim();
  if (!promptText) {
    throw new Error(`${source}: prompt file is empty`);
  }
  if (promptText.length > PROMPT_MAX_CHARS) {
    throw new Error(`${source}: prompt exceeds ${PROMPT_MAX_CHARS} chars (got ${promptText.length})`);
  }
  if (promptText.includes("</docs_context")) {
    throw new Error(`${source}: prompt must not close </docs_context> (engine owns the context block; mentioning <docs_context> in rules is fine)`);
  }
  return promptText;
}

/**
 * Czyta i waliduje plik promptu (wspólne dla startu przez env i dla defaultu z envConfig).
 * @param {string} path
 * @param {string} varName  nazwa źródła do komunikatów (np. "DOCS_CHAT_PROMPT_FILE")
 * @returns {string}  przycięty, zwalidowany tekst
 * @throws {Error}  nieczytelny, pusty, za długi albo domyka cudzy blok </docs_context>
 */
export function readPromptFile(path, varName = "DOCS_CHAT_PROMPT_FILE") {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (/** @type {any} */ error) {
    throw new Error(`${varName}: cannot read prompt file "${path}" (${error.code || error.message})`);
  }
  return validatePromptText(raw, varName);
}

/**
 * Ścieżka pliku promptu z env (DOCS_CHAT_PROMPT_FILE) albo undefined — admin API pisze
 * TYLKO tam, gdzie start serwisu czyta (jedno źródło prawdy). Ścieżki defaultowej (bez
 * zmiennej) pilnuje envConfig (resolvePromptText), nie ten moduł.
 * @param {Record<string, string|undefined>} env
 */
export function promptFilePathFromEnv(env) {
  const path = env.DOCS_CHAT_PROMPT_FILE;
  return path && path.trim() ? path.trim() : undefined;
}

/**
 * Treść promptu z jawnego env (DOCS_CHAT_PROMPT_FILE) — fail-closed.
 * (Ścieżki defaultowej pilnuje envConfig — resolvePromptText.)
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
export function promptFromEnv(env) {
  const path = promptFilePathFromEnv(env);
  if (!path) {
    return undefined;
  }
  return readPromptFile(path, "DOCS_CHAT_PROMPT_FILE");
}

/**
 * Podmiana treści promptu przez admin API: walidacja -> zapis pliku -> live-apply (app.mjs).
 * Ścieżka = tenant.promptFile (rozwiązana przy starcie przez envConfig: jawny env, opcja
 * testowa albo DEFAULT_PROMPT_FILE_PATH) — admin pisze tam, gdzie start czytał.
 * @param {string} raw  treść z żądania (raw — walidowana tutaj)
 * @param {{ promptFile?: string }} [options]
 * @returns {Promise<string>}  zwalidowany zapisany tekst
 */
export async function writePromptFile(raw, { promptFile } = {}) {
  const promptText = validatePromptText(raw, "admin prompt");
  const path = String(promptFile || "").trim();
  if (!path) {
    throw new PromptFileNotConfiguredError(
      "tenant has no prompt file — env-config instances always carry one (default created at first boot); inline tenants need DOCS_CHAT_PROMPT_FILE"
    );
  }
  try {
    await writeFile(path, promptText + "\n", "utf8");
  } catch (/** @type {any} */ error) {
    throw new Error(`cannot write prompt file "${path}" (${error.code || error.message})`);
  }
  return promptText;
}
