// @ts-check
// Rejestr tenanta asystenta dokumentacji — instancja = dokładnie jeden tenant z env
// (lib/tenants/envConfig.mjs; plan env-config-refactor).
//
// Zasady:
// - konfiguracja JAWNA (niesekretna) = env + defaulty (envConfig), walidowana przy starcie
//   (validateTenantConfig) — zła konfiguracja = proces nie wstaje, nie „500 na pierwszym żądaniu";
// - sekrety instancji przychodzą z env pod płaskimi nazwami DOCS_CHAT_* (resolveTenantSecrets);
//   klucz importu (SHA) może być rozwiązany wcześniej z bazy (options.indexKeyHashes —
//   lib/tenants/indexKeys.mjs: RAW generuje serwis przy pierwszym boocie, persist przez recreate)
// - tenant, który chce IZOLACJI obserwowalności (`langfuse.project: "own"`), nigdy nie wpada
//   cicho do wspólnego projektu — brak własnych kluczy = Langfuse wyłączony + ostrzeżenie
//   (albo błąd startu, gdy TENANTS_REQUIRE_SECRETS=true, czyli na produkcji);
// - kolekcje są JAWNĄ listą per locale (nie regułą prefiksu): tenant nie może sięgnąć po kolekcję
//   spoza swojej listy (nazwy kolekcji to nazewnictwo wdrożenia, nie schemat produktu).

/**
 * @typedef {Object} TenantCors
 * @property {string[]} origins  dokładne originy (`https://host`), wzorce `*.domena.pl`
 *   (dowolna subdomena, tylko https) albo `*` (każdy origin — ochroną są wtedy limity per IP
 *   i limity klucza LLM tenanta w proxy)
 *
 * @typedef {Object} TenantLimits
 * @property {{ max: number, windowSeconds: number }} perIp
 * @property {number|null} [perIpDaily]        dobowy limit per IP (drugi bucket limitera)
 * @property {number} [maxConcurrentPerIp]     równoległe strumienie z jednego IP
 * @property {number} [maxOutputTokens]        max_tokens odpowiedzi LLM
 *
 * @typedef {Object} TenantRetrieval
 * @property {number} vectorWeight
 * @property {number} textWeight
 * @property {number} limit
 *
 * @typedef {Object} TenantLangfuse
 * @property {boolean} enabled
 * @property {"own"|"shared"} project  `own` = klucze tylko z `DOCS_CHAT_LANGFUSE_*`;
 *   `shared` = dopuszczalny fallback do globalnych `LANGFUSE_*` (tylko tenant domowy CGC)
 *
 * @typedef {Object} TenantConfig
 * @property {string} id            `[a-z0-9-]{2,32}` — nazwa metryk; envConfig ustawia "docs"
 * @property {string} name          nazwa asystenta (persona w promptcie, `status`)
 * @property {string} organization
 * @property {string} siteUrl       origin strony dokumentacji (bez ścieżki) — absolutne URL-e źródeł;
 *   puste = nieznane (od env-config opcjonalne)
 * @property {string[]} locales     małe litery, np. ["pl"]
 * @property {string} defaultLocale
 * @property {Record<string, string>} collections  locale → collection_name (jawna lista)
 * @property {TenantCors} cors
 * @property {TenantLimits} limits
 * @property {string} model
 * @property {TenantRetrieval} retrieval
 * @property {string|undefined} [promptFile]  ścieżka pliku promptu rozwiązana przy starcie (jawny env,
 *   opcja testowa, default z promptFile.mjs) — admin API pisze tam, gdzie start czytał;
 *   inline tenanty bez pliku dostają 409 na PUT /api/v1/admin/prompt.
 * @property {string|undefined} [promptText]  PEŁNY prompt instancji z deployu (`DOCS_CHAT_PROMPT_FILE`,
 *   lib/tenants/promptFile.mjs — default tworzony z neutralnej bazy
 *   przy pierwszym boocie): ustawiony = instancja przejmuje treść promptu; blok <docs_context>
 *   dokłada silnik. Pusta wartość = błąd.
 * @property {string|undefined} [persona]  tekst persony z deployu (`DOCS_CHAT_PERSONA_FILE`,
 *   lib/tenants/persona.mjs): ustawiony = framework (lib/docsChat/prompts/framework.mjs) składa
 *   reguły groundingowe + personę. Bez obu = neutralna baza z kodu (prompts/base.mjs).
 * @property {TenantLangfuse} langfuse
 * @property {{ requireOwnKey: boolean }} llm   `requireOwnKey`: brak DOCS_CHAT_LLM_API_KEY = błąd, nie cichy fallback na klucz globalny
 * @property {{ requireSiteToken: boolean }} auth  `requireSiteToken`: czat i feedback wymagają nagłówka
 *   `X-Site-Token` (sekret wypiekany w build strony klienta; sha256 w TENANT_<ID>_SITE_TOKENS).
 *   Dla dokumentacji dostępnej tylko dla klientów: kto widzi stronę, ma czat; curl bez tokena = 401.
 *   CORS tego nie załatwia — chroni tylko przed cudzymi stronami, nie przed skryptem.
 */

/**
 * @typedef {Object} TenantSecrets
 * @property {{ baseUrl: string|undefined, apiKey: string|undefined }} llm
 * @property {{ enabled: boolean, baseUrl?: string, publicKey?: string, secretKey?: string }} langfuse
 * @property {string[]} indexKeyHashes  sha256 (hex) akceptowanych kluczy indeksowania (rotacja: ≥1)
 * @property {string[]} siteTokenHashes  sha256 (hex) akceptowanych tokenów strony (rotacja: ≥1); pusta = czat 503 przy `auth.requireSiteToken`
 */

import { SUPPORTED_LOCALES } from "../vdb/language.mjs";

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ORIGIN = /^https?:\/\/[^/\s?#]+$/i;
const WILDCARD_ORIGIN = /^\*\.[a-z0-9.-]+\.[a-z]{2,}$/i;
const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * @param {string} tenantId
 * @param {string} field
 * @param {string} requirement
 * @returns {never}
 */
function invalid(tenantId, field, requirement) {
  throw new Error(`Tenant "${tenantId}": ${field} ${requirement}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {string} tenantId
 * @param {unknown} value
 * @param {string} field
 */
function requireString(tenantId, value, field) {
  if (typeof value !== "string" || !value.trim()) {
    invalid(tenantId, field, "must be a non-empty string");
  }
  return /** @type {string} */ (value).trim();
}

/**
 * @param {string} tenantId
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, integer?: boolean }} [bounds]
 */
function requireNumber(tenantId, value, field, bounds = {}) {
  const number = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(number)) {
    invalid(tenantId, field, "must be a finite number");
  }
  if (bounds.integer && !Number.isInteger(number)) {
    invalid(tenantId, field, "must be an integer");
  }
  if (bounds.min !== undefined && number < bounds.min) {
    invalid(tenantId, field, `must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && number > bounds.max) {
    invalid(tenantId, field, `must be <= ${bounds.max}`);
  }
  return number;
}

/**
 * @param {string} tenantId
 * @param {unknown} value
 * @param {string} field
 */
function requireStringArray(tenantId, value, field) {
  if (!Array.isArray(value)) {
    invalid(tenantId, field, "must be an array");
  }
  return /** @type {unknown[]} */ (value).map((entry, index) =>
    requireString(tenantId, entry, `${field}[${index}]`)
  );
}

/**
 * Wzorzec originu CORS: dokładny origin, `*.domena.pl` albo `*`.
 * @param {string} tenantId
 * @param {string} pattern
 * @param {string} field
 */
function validateOriginPattern(tenantId, pattern, field) {
  if (pattern === "*" || ORIGIN.test(pattern) || WILDCARD_ORIGIN.test(pattern)) {
    return pattern;
  }
  return invalid(
    tenantId,
    field,
    'must be an http(s) origin without path, a "*.domain.tld" pattern or "*"'
  );
}

/**
 * siteUrl od env-config jest OPCJONALNE (puste = nieznany origin strony, linki relatywne).
 * Podane — musi być poprawnym originem (fail-closed jak wszystko).
 * @param {string} tenantId
 * @param {unknown} value
 */
function requireSiteUrl(tenantId, value) {
  const siteUrl = String(value || "").trim().replace(/\/+$/, "");
  if (siteUrl && !ORIGIN.test(siteUrl)) {
    invalid(tenantId, "siteUrl", "must be an http(s) origin without path (or empty)");
  }
  return siteUrl;
}

/**
 * Waliduje i normalizuje konfigurację jednego tenanta. Rzuca z czytelnym komunikatem
 * (`Tenant "x": field must …`) — pierwszy błąd zatrzymuje start procesu.
 * @param {unknown} raw
 * @param {object} [options]
 * @returns {TenantConfig}
 */
export function validateTenantConfig(raw, options = {}) {
  if (!isPlainObject(raw)) {
    throw new Error("Tenant config must be an object");
  }
  const tenantId = typeof raw.id === "string" ? raw.id : "?";
  if (!TENANT_ID.test(tenantId)) {
    invalid(tenantId, "id", "must match [a-z0-9][a-z0-9-]{1,31}");
  }

  const siteUrl = requireSiteUrl(tenantId, raw.siteUrl);

  const locales = requireStringArray(tenantId, raw.locales, "locales").map((locale) =>
    locale.toLowerCase()
  );
  if (locales.length === 0) {
    invalid(tenantId, "locales", "must contain at least one locale");
  }
  locales.forEach((locale, index) => {
    if (!SUPPORTED_LOCALES.includes(/** @type {any} */ (locale))) {
      // warstwa składowania (lib/vdb/language.mjs) zna tylko te języki — inna wartość zapisałaby
      // wiersze jako EN i rozjechała status/retrieval; fail-fast zamiast cichej korupcji
      invalid(tenantId, `locales[${index}]`, `must be one of: ${SUPPORTED_LOCALES.join(", ")}`);
    }
  });
  const defaultLocale = requireString(tenantId, raw.defaultLocale, "defaultLocale").toLowerCase();
  if (!locales.includes(defaultLocale)) {
    invalid(tenantId, "defaultLocale", "must be one of locales");
  }

  if (!isPlainObject(raw.collections)) {
    invalid(tenantId, "collections", "must be an object { locale: collectionName }");
  }
  /** @type {Record<string, string>} */
  const collections = {};
  for (const locale of locales) {
    const name = requireString(
      tenantId,
      /** @type {Record<string, unknown>} */ (raw.collections)[locale],
      `collections.${locale}`
    );
    if (!COLLECTION_NAME.test(name)) {
      invalid(tenantId, `collections.${locale}`, "must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    }
    collections[locale] = name;
  }
  for (const key of Object.keys(/** @type {object} */ (raw.collections))) {
    if (!locales.includes(key)) {
      invalid(tenantId, `collections.${key}`, "refers to a locale not listed in locales");
    }
  }

  if (!isPlainObject(raw.cors)) {
    invalid(tenantId, "cors", "must be an object");
  }
  const origins = requireStringArray(
    tenantId,
    /** @type {Record<string, unknown>} */ (raw.cors).origins,
    "cors.origins"
  ).map((pattern, index) => validateOriginPattern(tenantId, pattern, `cors.origins[${index}]`));
  if (origins.length === 0) {
    invalid(tenantId, "cors.origins", "must contain at least one origin pattern");
  }

  if (!isPlainObject(raw.limits) || !isPlainObject(raw.limits.perIp)) {
    invalid(tenantId, "limits", "must be { perIp: { max, windowSeconds } }");
  }
  const limitsRaw = /** @type {{ perIp: Record<string, unknown>, perIpDaily?: unknown, maxOutputTokens?: unknown, maxConcurrentPerIp?: unknown }} */ (
    raw.limits
  );
  const limits = {
    perIp: {
      max: requireNumber(tenantId, limitsRaw.perIp.max, "limits.perIp.max", { min: 1, integer: true }),
      windowSeconds: requireNumber(
        tenantId,
        limitsRaw.perIp.windowSeconds,
        "limits.perIp.windowSeconds",
        { min: 1, integer: true }
      ),
    },
    perIpDaily:
      limitsRaw.perIpDaily === undefined || limitsRaw.perIpDaily === null
        ? null
        : requireNumber(tenantId, limitsRaw.perIpDaily, "limits.perIpDaily", { min: 1, integer: true }),
    maxOutputTokens:
      limitsRaw.maxOutputTokens === undefined
        ? 1500
        : requireNumber(tenantId, limitsRaw.maxOutputTokens, "limits.maxOutputTokens", { min: 64, integer: true }),
    maxConcurrentPerIp:
      limitsRaw.maxConcurrentPerIp === undefined
        ? 5
        : requireNumber(tenantId, limitsRaw.maxConcurrentPerIp, "limits.maxConcurrentPerIp", { min: 1, integer: true }),
  };

  if (!isPlainObject(raw.retrieval)) {
    invalid(tenantId, "retrieval", "must be { vectorWeight, textWeight, limit }");
  }
  const retrievalRaw = /** @type {Record<string, unknown>} */ (raw.retrieval);
  const retrieval = {
    vectorWeight: requireNumber(tenantId, retrievalRaw.vectorWeight, "retrieval.vectorWeight", {
      min: 0,
      max: 1,
    }),
    textWeight: requireNumber(tenantId, retrievalRaw.textWeight, "retrieval.textWeight", {
      min: 0,
      max: 1,
    }),
    limit: requireNumber(tenantId, retrievalRaw.limit, "retrieval.limit", {
      min: 1,
      max: 20,
      integer: true,
    }),
  };
  if (retrieval.vectorWeight + retrieval.textWeight <= 0) {
    invalid(tenantId, "retrieval", "vectorWeight + textWeight must be > 0");
  }

  // `promptText` (opcjonalny): pełny prompt z DOCS_CHAT_PROMPT_FILE. Pusta wartość = błąd — pusty
  // plik nie ma prawa uruchamiać cichego fallbacku na bazę z kodu.
  const promptFile = raw.promptFile === undefined ? undefined : requireString(tenantId, raw.promptFile, "promptFile");
  const promptText = raw.promptText === undefined ? undefined : requireString(tenantId, raw.promptText, "promptText");

  // `persona` (opcjonalna): tekst z DOCS_CHAT_PERSONA_FILE. Pusta wartość = błąd — pusty plik
  // persony nie ma prawa uruchamiać cichego fallbacku na prompt z kodu.
  const persona = raw.persona === undefined ? undefined : requireString(tenantId, raw.persona, "persona");

  // `llm.requireOwnKey` — instancja rozliczana osobno (gateway billinguje per klucz): brak własnego
  // klucza musi zatrzymać start, bo inaczej koszty klienta po cichu obciążają konto CGC
  if (raw.llm !== undefined && (!isPlainObject(raw.llm) || typeof (/** @type {any} */ (raw.llm).requireOwnKey) !== "boolean")) {
    invalid(tenantId, "llm", "must be { requireOwnKey: boolean }");
  }
  const requireOwnLlmKey = Boolean(/** @type {any} */ (raw.llm)?.requireOwnKey);

  // `auth.requireSiteToken` — dokumentacja niepubliczna: bez tokena strony API oddawałoby fragmenty
  // podręcznika każdemu z curlem (CORS blokuje tylko cudze strony w przeglądarce)
  if (raw.auth !== undefined && (!isPlainObject(raw.auth) || typeof (/** @type {any} */ (raw.auth).requireSiteToken) !== "boolean")) {
    invalid(tenantId, "auth", "must be { requireSiteToken: boolean }");
  }
  const requireSiteToken = Boolean(/** @type {any} */ (raw.auth)?.requireSiteToken);

  if (!isPlainObject(raw.langfuse) || typeof raw.langfuse.enabled !== "boolean") {
    invalid(tenantId, "langfuse", 'must be { enabled: boolean, project: "own"|"shared" }');
  }
  const langfuseRaw = /** @type {{ enabled: boolean, project?: unknown }} */ (raw.langfuse);
  if (langfuseRaw.project !== "own" && langfuseRaw.project !== "shared") {
    invalid(tenantId, "langfuse.project", 'must be "own" or "shared"');
  }

  return {
    id: tenantId,
    name: requireString(tenantId, raw.name, "name"),
    organization: requireString(tenantId, raw.organization, "organization"),
    siteUrl,
    locales,
    defaultLocale,
    collections,
    cors: { origins },
    limits,
    model: requireString(tenantId, raw.model, "model"),
    retrieval,
    promptFile,
    promptText,
    persona,
    langfuse: { enabled: langfuseRaw.enabled, project: langfuseRaw.project },
    llm: { requireOwnKey: requireOwnLlmKey },
    auth: { requireSiteToken },
  };
}

/**
 * Lista sha256 (hex) z wartości rozdzielanej przecinkami — klucze indeksowania i tokeny
 * strony trzymamy (env, baza) wyłącznie jako skróty (wyciek nie daje sekretu).
 * @param {string} name   nazwa źródła (do komunikatu)
 * @param {string|undefined} value
 * @returns {string[]}
 */
export function parseSha256HexList(name, value) {
  const hashes = String(value || "")
    .split(",")
    .map((hash) => hash.trim().toLowerCase())
    .filter(Boolean);
  hashes.forEach((hash) => {
    if (!SHA256_HEX.test(hash)) {
      throw new Error(`${name} must be comma-separated sha256 hex digests`);
    }
  });
  return hashes;
}

/**
 * @param {string} tenantId
 * @param {string} name
 * @param {string|undefined} value
 */
function sha256ListFromEnv(tenantId, name, value) {
  try {
    return parseSha256HexList(name, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tenant "${tenantId}": ${message}`);
  }
}

/**
 * Sekrety instancji z env (płaskie DOCS_CHAT_*; konwencja TENANT_<ID>_* odchodzi — plan
 * env-config-refactor). Fallbacki do globalnych zmiennych są jawne i ograniczone:
 * - LLM: brak `DOCS_CHAT_LLM_*` → globalne `OPENAI_*` (jeden gateway; klucz per instancja to
 *   rozliczalność kosztów, nie bezpieczeństwo);
 * - Langfuse: fallback do globalnych `LANGFUSE_*` TYLKO dla `project: "shared"`.
 * - Klucz importu: `options.indexKeyHashes` (rozwiązany wcześniej z bazy przez
 *   lib/tenants/indexKeys.mjs) ma pierwszeństwo przed env DOCS_CHAT_INDEX_KEYS (env = rotacja).
 * @param {TenantConfig} tenant
 * @param {Record<string, string|undefined>} env
 * @param {{ requireSecrets?: boolean, warn?: (message: string) => void, indexKeyHashes?: string[] }} [options]
 * @returns {TenantSecrets}
 */
export function resolveTenantSecrets(tenant, env, options = {}) {
  const warn = options.warn || ((message) => console.warn(message));
  const requireSecrets =
    options.requireSecrets ??
    String(env.TENANTS_REQUIRE_SECRETS || "").trim().toLowerCase() === "true";

  /** @param {string} message */
  const missing = (message) => {
    if (requireSecrets) {
      throw new Error(message);
    }
    warn(message);
  };

  if (tenant.llm?.requireOwnKey && !env.DOCS_CHAT_LLM_API_KEY) {
    missing(
      `Tenant "${tenant.id}": llm.requireOwnKey=true but DOCS_CHAT_LLM_API_KEY is not set` +
        " — costs would silently fall back to the global CGC key"
    );
  }
  const llm = {
    baseUrl: env.DOCS_CHAT_LLM_BASE_URL || env.OPENAI_BASE_URL,
    apiKey: env.DOCS_CHAT_LLM_API_KEY || env.OPENAI_API_KEY,
  };

  /** @type {TenantSecrets["langfuse"]} */
  let langfuse = { enabled: false };
  if (tenant.langfuse.enabled) {
    const own = {
      baseUrl: env.DOCS_CHAT_LANGFUSE_BASE_URL,
      publicKey: env.DOCS_CHAT_LANGFUSE_PUBLIC_KEY,
      secretKey: env.DOCS_CHAT_LANGFUSE_SECRET_KEY,
    };
    // wyłącznik per instancja: DOCS_CHAT_LANGFUSE_ENABLED=false — świadome wyłączenie
    // obserwowalności bez kluczy, bez padania procesu
    const tenantSwitchOff =
      String(env.DOCS_CHAT_LANGFUSE_ENABLED || "").trim().toLowerCase() === "false";
    const sharedSwitchOn =
      String(env.LANGFUSE_ENABLED || "").trim().toLowerCase() === "true";
    // JAWNE `LANGFUSE_ENABLED=false` to świadome wyłączenie obserwowalności, a nie brak konfiguracji:
    // instancja na projekcie współdzielonym ma wtedy wystartować bez tracingu zamiast wywalić proces
    const sharedSwitchOff =
      String(env.LANGFUSE_ENABLED || "").trim().toLowerCase() === "false";
    const shared = sharedSwitchOn
      ? {
          baseUrl: env.LANGFUSE_HOST || env.LANGFUSE_BASEURL,
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
        }
      : { baseUrl: undefined, publicKey: undefined, secretKey: undefined };
    const chosen = tenantSwitchOff
      ? null
      : own.baseUrl && own.publicKey && own.secretKey
        ? own
        : tenant.langfuse.project === "shared"
          ? shared
          : null;
    if (chosen && chosen.baseUrl && chosen.publicKey && chosen.secretKey) {
      langfuse = {
        enabled: true,
        baseUrl: chosen.baseUrl,
        publicKey: chosen.publicKey,
        secretKey: chosen.secretKey,
      };
    } else if (tenant.langfuse.project === "shared" && sharedSwitchOff) {
      warn(`Tenant "${tenant.id}": tracing disabled by the global LANGFUSE_ENABLED=false switch`);
    } else if (!tenantSwitchOff) {
      missing(
        `Tenant "${tenant.id}": langfuse.enabled=true but DOCS_CHAT_LANGFUSE_{BASE_URL,PUBLIC_KEY,SECRET_KEY} are not set` +
          (tenant.langfuse.project === "shared"
            ? " (and the global LANGFUSE_* fallback is missing or LANGFUSE_ENABLED is not \"true\")"
            : "") +
          " — tracing disabled for this tenant"
      );
    }
  }

  // klucz importu: indexKeyHashes rozwiązany wcześniej (env > baza > wygenerowany —
  // lib/tenants/indexKeys.mjs) ma pierwszeństwo; env bez basowego rozwiązania = ścieżka rotacji
  const indexKeyHashes =
    options.indexKeyHashes ??
    sha256ListFromEnv(tenant.id, "DOCS_CHAT_INDEX_KEYS", env.DOCS_CHAT_INDEX_KEYS);
  if (indexKeyHashes.length === 0) {
    missing(`Tenant "${tenant.id}": DOCS_CHAT_INDEX_KEYS not set — indexing endpoints disabled for this tenant`);
  }

  // token strony: wymagany tylko przy `auth.requireSiteToken`; bez hashy czat odpowiada 503 (fail-closed),
  // a nie „przepuszczam, bo nic nie skonfigurowano" — brak sekretu nie może otwierać dokumentacji
  const siteTokenHashes = sha256ListFromEnv(tenant.id, "DOCS_CHAT_SITE_TOKENS", env.DOCS_CHAT_SITE_TOKENS);
  if (tenant.auth?.requireSiteToken && siteTokenHashes.length === 0) {
    missing(
      `Tenant "${tenant.id}": auth.requireSiteToken=true but DOCS_CHAT_SITE_TOKENS not set` +
        " — chat and feedback answer 503 until a token hash is configured"
    );
  } else if (!tenant.auth?.requireSiteToken && siteTokenHashes.length > 0) {
    warn(`Tenant "${tenant.id}": DOCS_CHAT_SITE_TOKENS is set but auth.requireSiteToken=false — tokens are ignored`);
  }

  return { llm, langfuse, indexKeyHashes, siteTokenHashes };
}

/**
 * @typedef {Object} TenantRegistry
 * @property {(id: unknown) => TenantConfig|null} get     `null` dla nieznanego/niepoprawnego id
 * @property {() => TenantConfig[]} list
 * @property {(id: string) => TenantSecrets} secrets     sekrety (rozwiązane raz przy starcie)
 */

// indexKeyHashes: sha256 klucza importu rozwiązane wcześniej z bazy (lib/tenants/indexKeys.mjs —
// RAW generowany przy pierwszym boocie, persist przez recreate); env DOCS_CHAT_INDEX_KEYS to rotacja.
/**
 * Buduje rejestr z konfiguracji (envConfig / dane testowe). Waliduje wszystko z góry.
 * @param {{
 *   tenants: unknown[],
 *   env?: Record<string, string|undefined>,
 *   requireSecrets?: boolean,
 *   warn?: (message: string) => void,
 *   indexKeyHashes?: string[],
 * }} options
 * @returns {TenantRegistry}
 */
export function createTenantRegistry(options) {
  const env = options.env || process.env;
  /** @type {Map<string, TenantConfig>} */
  const tenants = new Map();
  /** @type {Map<string, TenantSecrets>} */
  const secrets = new Map();

  /** @type {Map<string, string>} kolekcja → tenant, który jej używa (izolacja między tenantami) */
  const collectionOwners = new Map();
  for (const raw of options.tenants) {
    const tenant = validateTenantConfig(raw);
    if (tenants.has(tenant.id)) {
      throw new Error(`Tenant "${tenant.id}": duplicate id`);
    }
    // Własność importów jest sprawdzana po nazwie kolekcji (lib/server/app.mjs) — dwie konfiguracje
    // wskazujące tę samą kolekcję dałyby tenantowi A klucz do indeksu tenanta B. Fail-fast.
    for (const [locale, collectionName] of Object.entries(tenant.collections)) {
      const owner = collectionOwners.get(collectionName);
      if (owner && owner !== tenant.id) {
        throw new Error(
          `Tenant "${tenant.id}": collections.${locale} = "${collectionName}" is already owned by tenant "${owner}"`
        );
      }
      collectionOwners.set(collectionName, tenant.id);
    }
    tenants.set(tenant.id, tenant);
    secrets.set(
      tenant.id,
      resolveTenantSecrets(tenant, env, {
        requireSecrets: options.requireSecrets,
        warn: options.warn,
        indexKeyHashes: options.indexKeyHashes,
      })
    );
  }
  if (tenants.size === 0) {
    throw new Error("Tenant registry must contain at least one tenant");
  }

  return {
    get(id) {
      if (typeof id !== "string" || !TENANT_ID.test(id)) {
        return null;
      }
      return tenants.get(id) || null;
    },
    list() {
      return [...tenants.values()];
    },
    secrets(id) {
      const found = secrets.get(id);
      if (!found) {
        throw new Error(`Unknown tenant "${id}"`);
      }
      return found;
    },
  };
}
