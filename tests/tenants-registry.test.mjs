// @ts-check
// Rejestr/sekrety po refaktorze env-config: konfiguracja z env (envConfig), sekrety pod
// PŁASKIMI nazwami DOCS_CHAT_* (konwencja TENANT_<ID>_* odchodzi), klucz importu może
// przyjść rozwiązany wcześniej z bazy (options.indexKeyHashes — indexKeys.mjs).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptFromEnv } from "../lib/tenants/promptFile.mjs";
import {
  createTenantRegistry,
  parseSha256HexList,
  resolveTenantSecrets,
  validateTenantConfig,
} from "../lib/tenants/registry.mjs";

function validTenant(overrides = {}) {
  return {
    id: "acme",
    name: "Acme Assistant",
    organization: "Acme",
    siteUrl: "https://docs.acme.example",
    locales: ["pl"],
    defaultLocale: "pl",
    collections: { pl: "acme-docs-pl" },
    cors: { origins: ["https://docs.acme.example"] },
    limits: { perIp: { max: 10, windowSeconds: 60 } },
    model: "gemma-4-26b-a4b",
    retrieval: { vectorWeight: 0.5, textWeight: 0.5, limit: 5 },
    langfuse: { enabled: false, project: "own" },
    ...overrides,
  };
}

test("registry: walidacja configów przechodzi, sekrety z płaskich DOCS_CHAT_* env", () => {
  const warnings = [];
  const registry = createTenantRegistry({
    tenants: [validTenant()],
    env: {},

    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(registry.list().map((tenant) => tenant.id), ["acme"]);
  assert.deepEqual(registry.get("acme").collections, { pl: "acme-docs-pl" });
  // brak sekretów = ostrzeżenia (indeksowanie wyłączone), nie błąd startu
  assert.ok(warnings.some((message) => /DOCS_CHAT_INDEX_KEYS not set/.test(message)));
});

test("validateTenantConfig rejects malformed configs with a field-level message", () => {
  const cases = [
    [{ id: "Bad Id" }, /Tenant "Bad Id": id must match/],
    [{ siteUrl: "docs.acme.example" }, /siteUrl must be an http\(s\) origin/],
    [{ siteUrl: "https://docs.acme.example/manual" }, /siteUrl must be an http\(s\) origin without path/],
    [{ defaultLocale: "en" }, /defaultLocale must be one of locales/],
    [{ collections: { pl: "acme", en: "acme-en" } }, /collections\.en refers to a locale not listed/],
    [{ collections: { pl: "bad name!" } }, /collections\.pl must match/],
    [{ cors: { origins: ["https://a.example/path"] } }, /cors\.origins\[0\] must be an http\(s\) origin/],
    [{ cors: { origins: [] } }, /cors\.origins must contain at least one/],
    [{ limits: { perIp: { max: 0, windowSeconds: 60 } } }, /limits\.perIp\.max must be >= 1/],
    [{ retrieval: { vectorWeight: 0, textWeight: 0, limit: 5 } }, /vectorWeight \+ textWeight must be > 0/],
    [{ retrieval: { vectorWeight: 0.5, textWeight: 0.5, limit: 21 } }, /retrieval\.limit must be <= 20/],
    [{ promptText: "" }, /promptText must be a non-empty string/],
    [{ langfuse: { enabled: true, project: "global" } }, /langfuse\.project must be "own" or "shared"/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(() => validateTenantConfig(validTenant(overrides)), pattern);
  }
});

test("siteUrl od env-config jest opcjonalne (puste przechodzi), podane — walidowane", () => {
  const empty = validateTenantConfig(validTenant({ siteUrl: "" }));
  assert.equal(empty.siteUrl, "");
  const trimmed = validateTenantConfig(validTenant({ siteUrl: "https://docs.acme.example/" }));
  assert.equal(trimmed.siteUrl, "https://docs.acme.example");
  assert.throws(() => validateTenantConfig(validTenant({ siteUrl: "not-an-origin" })), /siteUrl/);
});

test("validateTenantConfig accepts wildcard and catch-all origin patterns", () => {
  const tenant = validateTenantConfig(
    validTenant({
      siteUrl: "https://docs.acme.example/",
      cors: { origins: ["https://docs.acme.example", "*.acme.example", "*"] },
    }),
  );
  assert.equal(tenant.siteUrl, "https://docs.acme.example");
  assert.deepEqual(tenant.cors.origins, ["https://docs.acme.example", "*.acme.example", "*"]);
});

test("registry: duplicate ids and empty lists are rejected; get() is null-safe for path segments", () => {
  assert.throws(
    () => createTenantRegistry({ tenants: [validTenant(), validTenant()], env: {} }),
    /duplicate id/
  );
  assert.throws(() => createTenantRegistry({ tenants: [], env: {} }), /at least one tenant/);

  const registry = createTenantRegistry({ tenants: [validTenant()], env: {} });
  assert.equal(registry.get("acme").id, "acme");
  assert.equal(registry.get("ACME"), null);
  assert.equal(registry.get("../acme"), null);
  assert.equal(registry.get(undefined), null);
  assert.equal(registry.get(""), null);
  assert.throws(() => registry.secrets("nope"), /Unknown tenant/);
});

test("secrets: own Langfuse project never falls back to the shared LANGFUSE_* keys", () => {
  const tenant = validateTenantConfig(validTenant({ langfuse: { enabled: true, project: "own" } }));

  const warnings = [];
  const sharedOnly = resolveTenantSecrets(
    tenant,
    { LANGFUSE_HOST: "https://lf", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
    { warn: (message) => warnings.push(message) }
  );
  assert.equal(sharedOnly.langfuse.enabled, false);
  assert.match(warnings[0], /tracing disabled/);

  const own = resolveTenantSecrets(
    tenant,
    {
      DOCS_CHAT_LANGFUSE_BASE_URL: "https://lf",
      DOCS_CHAT_LANGFUSE_PUBLIC_KEY: "pk-own",
      DOCS_CHAT_LANGFUSE_SECRET_KEY: "sk-own",
    },
    { warn() {} }
  );
  assert.deepEqual(own.langfuse, {
    enabled: true,
    baseUrl: "https://lf",
    publicKey: "pk-own",
    secretKey: "sk-own",
  });
});

test("secrets: shared Langfuse project falls back to global keys; LLM falls back to OPENAI_*", () => {
  const tenant = validateTenantConfig(validTenant({ langfuse: { enabled: true, project: "shared" } }));

  const secrets = resolveTenantSecrets(
    tenant,
    {
      LANGFUSE_ENABLED: "true",
      LANGFUSE_BASEURL: "https://lf",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      OPENAI_BASE_URL: "https://llm/v1",
      OPENAI_API_KEY: "global-key",
      DOCS_CHAT_LLM_API_KEY: "tenant-key",
    },
    { warn() {} }
  );
  assert.equal(secrets.langfuse.enabled, true);
  assert.equal(secrets.langfuse.publicKey, "pk");
  assert.deepEqual(secrets.llm, { baseUrl: "https://llm/v1", apiKey: "tenant-key" });
});

test("secrets: index keys are sha256 digests (rotation-friendly list); strict mode fails fast", () => {
  const tenant = validateTenantConfig(validTenant());
  const digest = "a".repeat(64);
  const secrets = resolveTenantSecrets(
    tenant,
    { DOCS_CHAT_INDEX_KEYS: ` ${digest.toUpperCase()}, ${"b".repeat(64)} ` },
    { warn() {} }
  );
  assert.deepEqual(secrets.indexKeyHashes, [digest, "b".repeat(64)]);

  assert.throws(
    () => resolveTenantSecrets(tenant, { DOCS_CHAT_INDEX_KEYS: "plaintext-key" }, { warn() {} }),
    /must be comma-separated sha256 hex digests/
  );
  assert.throws(
    () => resolveTenantSecrets(tenant, { TENANTS_REQUIRE_SECRETS: "true" }, { warn() {} }),
    /DOCS_CHAT_INDEX_KEYS not set/
  );
  assert.throws(
    () => resolveTenantSecrets(tenant, {}, { requireSecrets: true, warn() {} }),
    /DOCS_CHAT_INDEX_KEYS not set/
  );
});

test("secrets: indexKeyHashes rozwiązane wcześniej (baza — indexKeys.mjs) wygrywają z env (rotacja świadoma)", () => {
  const tenant = validateTenantConfig(validTenant());
  const fromDb = "c".repeat(64);
  const secrets = resolveTenantSecrets(
    tenant,
    { DOCS_CHAT_INDEX_KEYS: "a".repeat(64) },
    { indexKeyHashes: [fromDb], warn() {} }
  );
  assert.deepEqual(secrets.indexKeyHashes, [fromDb]);
  // registry: ta sama opcja przechodzi przez createTenantRegistry
  const registry = createTenantRegistry({
    tenants: [validTenant()],
    env: { DOCS_CHAT_INDEX_KEYS: "a".repeat(64) },
    indexKeyHashes: [fromDb],
    warn() {},
  });
  assert.deepEqual(registry.secrets("acme").indexKeyHashes, [fromDb]);
});

test("parseSha256HexList: walidacja hex, lista po przecinku, pusta → []", () => {
  assert.deepEqual(parseSha256HexList("X", ""), []);
  assert.deepEqual(parseSha256HexList("X", undefined), []);
  const digest = "a".repeat(64);
  assert.deepEqual(parseSha256HexList("X", ` ${digest.toUpperCase()} `), [digest]);
  assert.throws(() => parseSha256HexList("X", "zz"), /X must be comma-separated sha256 hex digests/);
});

// --- poprawki po zimnym przeglądzie (paczka A) ---
test("registry rejects two tenants sharing a collection name (index-key isolation invariant)", () => {
  const first = validTenant();
  const second = validTenant({ id: "other", collections: { pl: "acme-docs-pl" } });
  assert.throws(
    () => createTenantRegistry({ tenants: [first, second], env: {} }),
    /collections\.pl = "acme-docs-pl" is already owned by tenant "acme"/
  );
});

test("locales outside the storage layer (en|pl) fail startup validation — no silent EN coercion", () => {
  assert.throws(
    () => validateTenantConfig(validTenant({ locales: ["de"], defaultLocale: "de", collections: { de: "acme-docs-de" } })),
    /locales\[0\] must be one of: en, pl/
  );
});

test("shared Langfuse fallback honors the LANGFUSE_ENABLED master switch; per-instance switch can force-disable", () => {
  const shared = validateTenantConfig(validTenant({ langfuse: { enabled: true, project: "shared" } }));
  const keys = { LANGFUSE_HOST: "https://lf", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };
  // klucze są, ale masterswitch nie jest "true" → wyłączone (parytet z getLangfuseConfig)
  assert.equal(resolveTenantSecrets(shared, keys, { warn() {} }).langfuse.enabled, false);
  assert.equal(resolveTenantSecrets(shared, { ...keys, LANGFUSE_ENABLED: "true" }, { warn() {} }).langfuse.enabled, true);

  const own = validateTenantConfig(validTenant({ langfuse: { enabled: true, project: "own" } }));
  const ownKeys = {
    DOCS_CHAT_LANGFUSE_BASE_URL: "https://lf",
    DOCS_CHAT_LANGFUSE_PUBLIC_KEY: "pk",
    DOCS_CHAT_LANGFUSE_SECRET_KEY: "sk",
  };
  assert.equal(resolveTenantSecrets(own, ownKeys, { warn() {} }).langfuse.enabled, true);
  const warnings = [];
  const disabled = resolveTenantSecrets(own, { ...ownKeys, DOCS_CHAT_LANGFUSE_ENABLED: "false" }, { warn: (m) => warnings.push(m) });
  assert.equal(disabled.langfuse.enabled, false);
  assert.ok(!warnings.some((m) => /langfuse/i.test(m)), "explicit off is not a misconfiguration warning");
});

test("llm.requireOwnKey: brak własnego klucza instancji zatrzymuje start zamiast obciążać konto CGC", () => {
  const billed = validateTenantConfig(validTenant({ llm: { requireOwnKey: true } }));
  const env = { OPENAI_API_KEY: "globalny-klucz-cgc", OPENAI_BASE_URL: "https://llm/v1", DOCS_CHAT_INDEX_KEYS: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };

  assert.throws(
    () => resolveTenantSecrets(billed, env, { requireSecrets: true, warn() {} }),
    /DOCS_CHAT_LLM_API_KEY is not set/
  );
  // bez trybu wymagającego: ostrzeżenie, nie zatrzymanie procesu
  const warnings = [];
  const relaxed = resolveTenantSecrets(billed, env, { warn: (m) => warnings.push(m) });
  assert.equal(relaxed.llm.apiKey, "globalny-klucz-cgc");
  assert.ok(warnings.some((m) => /LLM_API_KEY is not set/.test(m)));

  // własny klucz obecny → bez ostrzeżeń, klucz instancji
  const ok = resolveTenantSecrets(billed, { ...env, DOCS_CHAT_LLM_API_KEY: "klucz-klienta" }, { requireSecrets: true, warn() {} });
  assert.equal(ok.llm.apiKey, "klucz-klienta");

  // instancja bez tego wymagania korzysta z globalnego klucza świadomie
  const home = validateTenantConfig(validTenant({ llm: { requireOwnKey: false } }));
  assert.equal(resolveTenantSecrets(home, env, { requireSecrets: true, warn() {} }).llm.apiKey, "globalny-klucz-cgc");

  assert.throws(() => validateTenantConfig(validTenant({ llm: { requireOwnKey: "tak" } })), /llm must be/);
});

test("LANGFUSE_ENABLED=false to świadome wyłączenie, nie brak konfiguracji — instancja współdzielona wstaje", () => {
  const shared = validateTenantConfig(validTenant({ langfuse: { enabled: true, project: "shared" } }));
  const warnings = [];
  const secrets = resolveTenantSecrets(shared, { LANGFUSE_ENABLED: "false", DOCS_CHAT_INDEX_KEYS: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { requireSecrets: true, warn: (m) => warnings.push(m) });
  assert.equal(secrets.langfuse.enabled, false);
  assert.ok(warnings.some((m) => /disabled by the global LANGFUSE_ENABLED=false/.test(m)));

  // masterswitch NIEUSTAWIONY przy braku kluczy to nadal błąd konfiguracji (ktoś zapomniał)
  assert.throws(
    () => resolveTenantSecrets(shared, { DOCS_CHAT_INDEX_KEYS: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { requireSecrets: true, warn() {} }),
    /LANGFUSE_\{BASE_URL,PUBLIC_KEY,SECRET_KEY\} are not set/
  );
});

test("auth.requireSiteToken: walidacja pola, hashe z DOCS_CHAT_SITE_TOKENS, strict mode zatrzymuje start bez hashy", () => {
  assert.equal(validateTenantConfig(validTenant()).auth.requireSiteToken, false);
  assert.throws(() => validateTenantConfig(validTenant({ auth: { requireSiteToken: "yes" } })), /auth must be \{ requireSiteToken: boolean \}/);
  const gated = validateTenantConfig(validTenant({ auth: { requireSiteToken: true } }));
  assert.equal(gated.auth.requireSiteToken, true);

  const digest = "c".repeat(64);
  const secrets = resolveTenantSecrets(gated, { DOCS_CHAT_SITE_TOKENS: ` ${digest.toUpperCase()} ,${"d".repeat(64)}` }, { warn() {} });
  assert.deepEqual(secrets.siteTokenHashes, [digest, "d".repeat(64)]);
  assert.throws(
    () => resolveTenantSecrets(gated, { DOCS_CHAT_SITE_TOKENS: "plaintext-token" }, { warn() {} }),
    /DOCS_CHAT_SITE_TOKENS must be comma-separated sha256 hex digests/
  );
  // brak hashy: ostrzeżenie (dev) albo błąd startu (TENANTS_REQUIRE_SECRETS) — nigdy cichy „przepuszczam wszystkich"
  const warnings = [];
  assert.deepEqual(resolveTenantSecrets(gated, {}, { warn: (m) => warnings.push(m) }).siteTokenHashes, []);
  assert.ok(warnings.some((m) => /DOCS_CHAT_SITE_TOKENS not set/.test(m)));
  // strict: klucz indeksu jest, brakuje tylko tokena — to on zatrzymuje start
  assert.throws(
    () => resolveTenantSecrets(gated, { TENANTS_REQUIRE_SECRETS: "true", DOCS_CHAT_INDEX_KEYS: "a".repeat(64) }, { warn() {} }),
    /DOCS_CHAT_SITE_TOKENS not set/
  );

  // instancja publiczna z hashami w env: ostrzeżenie o ignorowaniu (ktoś ustawił env, ale nie flagę)
  const open = validateTenantConfig(validTenant());
  const ignored = [];
  resolveTenantSecrets(open, { DOCS_CHAT_SITE_TOKENS: digest }, { warn: (m) => ignored.push(m) });
  assert.ok(ignored.some((m) => /SITE_TOKENS is set but auth.requireSiteToken=false/.test(m)));
});

test("promptText = dane deployu: DOCS_CHAT_PROMPT_FILE przechodzi przez walidację; pusty plik fail-closed", () => {
  const withPrompt = validateTenantConfig(validTenant({ promptText: "Reguły produktowe wdrożenia." }));
  assert.equal(withPrompt.promptText, "Reguły produktowe wdrożenia.");

  const dir = mkdtempSync(join(tmpdir(), "prompt-file-"));
  const path = join(dir, "prompt.txt");
  writeFileSync(path, "Pełny prompt z deployu.", "utf8");
  try {
    assert.equal(promptFromEnv({ DOCS_CHAT_PROMPT_FILE: path }), "Pełny prompt z deployu.");
    assert.equal(promptFromEnv({}), undefined);
    // pusty plik = błąd (fail-closed), nie cichy fallback na bazę z kodu
    writeFileSync(path, "   ", "utf8");
    assert.throws(() => promptFromEnv({ DOCS_CHAT_PROMPT_FILE: path }), /prompt file is empty/);
    // domknięcie cudzego bloku = własność silnika (wzmianka <docs_context> w regułach jest legalna — paritet z promptem ask)
    writeFileSync(path, "x <docs_context>y</docs_context>", "utf8");
    assert.throws(() => promptFromEnv({ DOCS_CHAT_PROMPT_FILE: path }), /must not close <\/docs_context>/);
    writeFileSync(path, "Cite fragments inside <docs_context> as [n].", "utf8");
    assert.equal(promptFromEnv({ DOCS_CHAT_PROMPT_FILE: path }), "Cite fragments inside <docs_context> as [n].");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
