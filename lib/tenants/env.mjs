// @ts-check
// Pomocnicze parsery env dla konfiguracji instancji (bez zależności).

/**
 * @param {string|undefined} value
 * @param {number} fallback
 */
export function positiveIntegerFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Liczba (float, np. wagi retrievalu); NaN/brak → fallback.
 * @param {string|undefined} value
 * @param {number} fallback
 */
export function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Boolean z env: jawnie "true"/"false" (case-insensitive); brak/inna wartość → fallback.
 * @param {string|undefined} value
 * @param {boolean} fallback
 */
export function boolFromEnv(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

/**
 * Lista rozdzielana przecinkami; pusta/brak → fallback.
 * @param {string|undefined} value
 * @param {string[]} fallback
 */
export function splitList(value, fallback) {
  const entries = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}
