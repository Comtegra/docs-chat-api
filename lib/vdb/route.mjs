// @ts-check
// Trasy dokumentacji (Docusaurus permalink ↔ metadata.route chunków) — plan §4.2 (E1b).
// Jedno miejsce dla: normalizacji trasy z metadanych, kodowania segmentów jak w ingest
// (Python `urllib.parse.quote(part)`), kandydatów dopasowania w SQL i budowy URL.

/**
 * Segmenty zakodowane jak w ingest (`quote()` per segment): encodeURIComponent + `!'()*`
 * (których encodeURIComponent nie koduje, a quote() tak); `~` oba zostawiają.
 * Obecny korpus ma tylko [A-Za-z0-9/_.\- ] — liczy się `%20`; reszta dla parzystości.
 * @param {string} route
 */
export function encodeRouteSegments(route) {
  return String(route)
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join("/");
}

/**
 * decodeURIComponent tolerujący uszkodzone sekwencje `%` (zwraca wejście).
 * @param {string} value
 */
export function safeDecodeRoute(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Trasa z metadanych chunka: przycięta, ZDEKODOWANA (stare wiersze ingestu mają `%20`, nowe
 * surowe spacje — na drucie zawsze jedna, surowa postać, jak `metadata.permalink`
 * Docusaurusa i `activeDoc.path`), albo null (web-info bez trasy).
 * @param {unknown} metadata
 * @returns {string|null}
 */
export function routeFromMetadata(metadata) {
  const raw = /** @type {{ route?: unknown } | null | undefined} */ (metadata)?.route;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return safeDecodeRoute(raw.trim());
}

/**
 * Absolutny URL strony docs dla trasy (segmenty zakodowane — href gotowy do użycia).
 * @param {string} docsSiteUrl  bez końcowego "/"
 * @param {string} route        surowa trasa (z routeFromMetadata)
 */
export function docsUrlForRoute(docsSiteUrl, route) {
  return `${docsSiteUrl}${encodeRouteSegments(route)}`;
}

/**
 * Kandydaci dopasowania `metadata.route` dla permalinku z klienta: surowy / zdekodowany /
 * zakodowany × z „/" na końcu / bez (≤ 6, dedup) — pokrywa stare dane ingestu (zakodowane,
 * bez „/" dla README) i nowe (surowy permalink z „/"). null gdy brak trasy.
 * @param {unknown} route
 * @returns {string[]|null}
 */
export function buildRouteCandidates(route) {
  if (typeof route !== "string" || !route.trim()) {
    return null;
  }
  const raw = route.trim();
  const noSlash = raw.replace(/\/+$/, "") || "/";
  const decoded = safeDecodeRoute(noSlash);
  const encoded = encodeRouteSegments(decoded);
  /** @param {string} value */
  const withSlash = (value) => (value === "/" ? "/" : `${value}/`);
  return [
    ...new Set([noSlash, withSlash(noSlash), decoded, withSlash(decoded), encoded, withSlash(encoded)]),
  ];
}
