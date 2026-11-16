// @ts-check
// Persona instancji z zewnątrz: DOCS_CHAT_PERSONA_FILE wskazuje plik z tekstem persony
// (sama persona — reguły groundingowe składa framework, lib/docsChat/prompts/framework.mjs).
// Obecność = instancja montuje personę klienta; brak = prompt z kodu (paritet z prod).
// Fail-closed jak reszta konfiguracji: zły plik zatrzymuje start, nie cichy fallback.

import { readFileSync } from "node:fs";

/** Górny sufit persony: chroni przed przypadkowo podłożonym plikiem (np. całym podręcznikiem). */
export const PERSONA_MAX_CHARS = 4000;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}  przycięty tekst persony albo undefined (brak zmiennej)
 * @throws {Error}  plik nieczytelny, pusty, za długi albo zawiera znaczniki <docs_context>
 */
export function personaFromEnv(env) {
  const varName = "DOCS_CHAT_PERSONA_FILE";
  const path = env[varName];
  if (!path || !path.trim()) {
    return undefined;
  }
  let raw;
  try {
    raw = readFileSync(path.trim(), "utf8");
  } catch (/** @type {any} */ error) {
    throw new Error(`${varName}: cannot read persona file "${path.trim()}" (${error.code || error.message})`);
  }
  const persona = String(raw || "").trim();
  if (!persona) {
    throw new Error(`${varName}: persona file is empty`);
  }
  if (persona.length > PERSONA_MAX_CHARS) {
    throw new Error(`${varName}: persona exceeds ${PERSONA_MAX_CHARS} chars (got ${persona.length})`);
  }
  if (persona.includes("<docs_context")) {
    // blok kontekstu dokłada silnik — persona z domkniętym cudzym blokiem psuje prompt
    throw new Error(`${varName}: persona must not contain "<docs_context" markers (the engine owns the context block)`);
  }
  return persona;
}
