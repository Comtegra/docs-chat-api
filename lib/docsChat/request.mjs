// @ts-check
const MAX_PROMPT_LENGTH = 2000;

/**
 * @param {unknown} source
 * @returns {string|null}
 */
export function normalizeDocusaurusSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    return null;
  }

  const normalized = source.trim().replace(/\\/g, "/");
  const prefixes = [
    "@site/i18n/pl/docusaurus-plugin-content-docs/current/",
    "@site/docs/",
  ];

  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }

  return normalized
    .replace(/^@site\//, "")
    .replace(/^docs\//, "")
    .replace(/^i18n\/pl\/docusaurus-plugin-content-docs\/current\//, "");
}

/**
 * @param {unknown} locale
 * @param {{ defaultLocale?: string, allowedLocales?: string[] }} [policy]
 *   tenant: domyślne locale i lista dozwolonych (rejestr); bez policy — zachowanie legacy (en|pl, domyślnie en)
 * @returns {"EN"|"PL"}
 */
export function normalizeLocale(locale, policy = {}) {
  const allowed = policy.allowedLocales || ["en", "pl"];
  const normalized = String(locale || policy.defaultLocale || "en").trim().toLowerCase();
  if (!allowed.includes(normalized) || !/^[a-z]{2}$/.test(normalized)) {
    throw new Error(`locale must be ${allowed.join(" or ")}`);
  }
  return /** @type {"EN"|"PL"} */ (normalized.toUpperCase());
}

// id wdrożenia (np. `?r=` z linku do instrukcji): nieprzezroczysty, ≤ 128 znaków drukowalnych —
// tylko do atrybucji w obserwowalności, nigdy do autoryzacji.
// base64url-owy zbiór: id wdrożenia trafia do Langfuse/logów/raportów — bez znaków HTML/SQL/CRLF
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {unknown} client
 * @returns {string|null}
 */
export function normalizeClientId(client) {
  if (typeof client !== "string") {
    return null;
  }
  const trimmed = client.trim();
  return CLIENT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * @param {unknown} scope
 * @returns {"page"|"all"}
 */
export function normalizeScope(scope) {
  const normalized = String(scope || "page").trim().toLowerCase();
  if (normalized === "page" || normalized === "all") {
    return normalized;
  }
  throw new Error("scope must be page or all");
}

/**
 * @param {unknown} prompt
 * @returns {string}
 */
function requiredPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt is required");
  }

  const trimmed = prompt.trim();
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }

  return trimmed;
}

// permalink strony: zaczyna się od "/", bez znaków kontrolnych, ≤ 512 znaków — inaczej
// ignorowany (parametryzowany SQL i tak jest bezpieczny; to higiena, nie ochrona).
// UWAGA: spacje są legalne — permalinki Docusaurusa mają surowe spacje (`/Getting Started/…`).
// eslint-disable-next-line no-control-regex
const ROUTE_PATTERN = /^\/[^\u0000-\u001f\u007f]{0,511}$/;

/**
 * @param {unknown} permalink
 * @returns {string|null}
 */
export function normalizePageRoute(permalink) {
  if (typeof permalink !== "string") {
    return null;
  }
  const trimmed = permalink.trim();
  return ROUTE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * @typedef {Object} DocsChatRequest
 * @property {string} prompt
 * @property {"EN"|"PL"} locale
 * @property {"page"|"all"} scope
 * @property {string|null} client  id wdrożenia (atrybucja), opcjonalny
 * @property {{ source: string|null, sourceFilePath: string|null, route: string|null, title: string|null }} page
 */

/**
 * @param {any} body
 * @param {{ defaultLocale?: string, allowedLocales?: string[] }} [localePolicy]
 * @returns {DocsChatRequest}
 */
export function validateDocsChatRequest(body, localePolicy = {}) {
  const prompt = requiredPrompt(body?.prompt);
  const locale = normalizeLocale(body?.locale, localePolicy);
  const scope = normalizeScope(body?.scope);
  const sourceFilePath = normalizeDocusaurusSource(body?.page?.source);
  const route = normalizePageRoute(body?.page?.permalink);

  // zakres strony: wystarczy `permalink` (klient po E2, dopasowanie po metadata.route)
  // LUB `source` (klient sprzed E2, dopasowanie po sourceFilePath) — plan §4.2
  if (scope === "page" && !sourceFilePath && !route) {
    throw new Error("page.permalink or page.source is required for page scoped chat");
  }

  return {
    prompt,
    locale,
    scope,
    client: normalizeClientId(body?.client),
    page: {
      source: typeof body?.page?.source === "string" ? body.page.source.trim() : null,
      sourceFilePath,
      route,
      title:
        typeof body?.page?.title === "string" && body.page.title.trim()
          ? body.page.title.trim()
          : null,
    },
  };
}
