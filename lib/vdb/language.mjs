// @ts-check
// Język kolekcji (kolumna `language`: "EN"|"PL") i wnioskowanie języka z sufiksu nazwy kolekcji.
// Wydzielone z documents.mjs, żeby imports.mjs nie importował modułu zapytań (brak cyklu).

// Języki wspierane przez warstwę składowania: kolumna `language` i kolekcje istnieją tylko dla
// tych wartości. Rejestr tenantów WALIDUJE locale tenanta przeciw tej liście (fail-fast przy
// starcie) — bez tego tenant z locale "de" przechodziłby walidację, a indeks zapisywałby wiersze
// jako EN i status nigdy nie widziałby aktywnego importu.
export const SUPPORTED_LOCALES = /** @type {const} */ (["en", "pl"]);

/**
 * @param {unknown} language
 * @returns {"EN"|"PL"}
 */
export function normalizeLanguage(language) {
  return String(language || "EN").trim().toUpperCase() === "PL" ? "PL" : "EN";
}

/**
 * Język z sufiksu nazwy kolekcji (`…-pl` / `…PL` → PL, inaczej EN) — eksportery bez pola `language`
 * (wysyłające kolekcję wprost) dostają spójny klucz kolekcji bez jawnego locale.
 * @param {unknown} collectionName
 */
export function inferLanguageFromCollection(collectionName) {
  return String(collectionName || "").toUpperCase().endsWith("PL") ? "PL" : "EN";
}
