// @ts-check
// envConfig: konfiguracja instancji z czystego env + defaultów (plan env-config-refactor).
// Kontrakt user-facing (install.md): DATABASE_URL, OPENAI_API_KEY, DOCS_CHAT_LOCALES,
// DOCS_CHAT_MODEL, DOCS_CHAT_CORS_ORIGINS; reszta = internal z defaultami (lib/tenants/envConfig.mjs).

import assert from "node:assert/strict";
import { DEFAULT_PROMPT_FILE_PATH } from "../lib/tenants/promptFile.mjs";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tenantConfigFromEnv } from "../lib/tenants/envConfig.mjs";

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "env-config-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("defaults: pusty env = pełna konfiguracja (pl-first, gwiazdka CORS, gemma)", () => {
  const promptDir = mkdtempSync(join(tmpdir(), "env-config-defaults-"));
  try {
  const tenant = tenantConfigFromEnv({ warn() {} }, { defaultPromptFile: join(promptDir, "prompt.md") });
  assert.equal(tenant.id, "docs");
  assert.equal(tenant.name, "Docs Chat");
  assert.deepEqual(tenant.locales, ["pl"]);
  assert.equal(tenant.defaultLocale, "pl");
  assert.deepEqual(tenant.collections, { pl: "docs-pl" });
  assert.deepEqual(tenant.cors.origins, ["*"]);
  assert.equal(tenant.model, "gemma-4-26b-a4b");
  assert.equal(tenant.siteUrl, "");
  assert.equal(tenant.llm.requireOwnKey, false);
  assert.equal(tenant.auth.requireSiteToken, false);
  assert.equal(tenant.langfuse.enabled, false);
  assert.equal(tenant.langfuse.project, "own");
  assert.deepEqual(tenant.limits.perIp, { max: 20, windowSeconds: 600 });
  assert.equal(tenant.limits.perIpDaily, 200);
  assert.equal(tenant.limits.maxConcurrentPerIp, 5);
  assert.equal(tenant.limits.maxOutputTokens, 1500);
  assert.deepEqual(tenant.retrieval, { vectorWeight: 0.3, textWeight: 0.7, limit: 5 });
  assert.ok(tenant.promptText && tenant.promptText.includes("You are a documentation assistant."), "default prompt file created from base");
  // ścieżka trafia do tenant.promptFile — admin API pisze dokładnie tam, gdzie start czytał
  assert.equal(tenant.promptFile, join(promptDir, "prompt.md"), "promptFile = default path (resolved at boot)");
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
});

test("overrides: LOCALES lista po przecinku (pierwsza = default), kolekcje auto, CORS, model, liczby", () => {
  const tenant = tenantConfigFromEnv(
    {
      DOCS_CHAT_LOCALES: "en, pl",
      DOCS_CHAT_CORS_ORIGINS: "https://docs.example.com, *.example.com",
      DOCS_CHAT_MODEL: "inny-model",
      DOCS_CHAT_NAME: "Asystent Klienta",
      DOCS_CHAT_SITE_URL: "https://docs.example.com/",
      DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS: "30",
      DOCS_CHAT_RETRIEVAL_VECTOR_WEIGHT: "0.6",
      DOCS_CHAT_RETRIEVAL_TEXT_WEIGHT: "0.4",
      DOCS_CHAT_AUTH_REQUIRE_SITE_TOKEN: "true",
      LANGFUSE_ENABLED: "true",
    },
    { warn() {}, defaultPromptFile: join(tmpdir(), "not-created", "prompt.md") }
  );
  assert.deepEqual(tenant.locales, ["en", "pl"]);
  assert.equal(tenant.defaultLocale, "en");
  assert.deepEqual(tenant.collections, { en: "docs-en", pl: "docs-pl" });
  assert.deepEqual(tenant.cors.origins, ["https://docs.example.com", "*.example.com"]);
  assert.equal(tenant.model, "inny-model");
  assert.equal(tenant.name, "Asystent Klienta");
  assert.equal(tenant.siteUrl, "https://docs.example.com");
  assert.equal(tenant.limits.perIp.max, 30);
  assert.deepEqual(tenant.retrieval, { vectorWeight: 0.6, textWeight: 0.4, limit: 5 });
  assert.equal(tenant.auth.requireSiteToken, true);
  assert.equal(tenant.langfuse.enabled, true);
});

const X_DEFAULT = { warn() {}, defaultPromptFile: join(tmpdir(), "env-config-x", "prompt.md") };

test("fail-closed: zły locale i zły wzorzec CORS = throw (boot pada); zła liczba = fallback defaulta", () => {
  assert.throws(() => tenantConfigFromEnv({ DOCS_CHAT_LOCALES: "de" }, X_DEFAULT), /locales\[0\] must be one of: en, pl/);
  assert.throws(
    () => tenantConfigFromEnv({ DOCS_CHAT_CORS_ORIGINS: "not-an-origin" }, X_DEFAULT),
    /cors\.origins\[0\]/
  );
  // liczby jak limity: śmieci w env = default (lenient, paritet z positiveIntegerFromEnv) —
  // wartość poza zakresem (waga > 1) i tak zatrzyma boot w walidacji rejestru
  const tenant = tenantConfigFromEnv({ DOCS_CHAT_RETRIEVAL_VECTOR_WEIGHT: "abc" }, X_DEFAULT);
  assert.equal(tenant.retrieval.vectorWeight, 0.3);
  assert.throws(
    () => tenantConfigFromEnv({ DOCS_CHAT_RETRIEVAL_VECTOR_WEIGHT: "5" }, X_DEFAULT),
    /retrieval\.vectorWeight/
  );
});

test("prompt default: brak pliku = tworzony z neutralnej bazy (admin/prompt działa od razu)", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-config-prompt-"));
  const path = join(dir, "nested", "prompt.md");
  try {
    const tenant = tenantConfigFromEnv({ warn() {} }, { defaultPromptFile: path });
    assert.ok(tenant.promptText && tenant.promptText.includes("You are a documentation assistant."));
    assert.ok(!tenant.promptText.includes("</docs_context"), "bez bloku kontekstu — dokłada silnik");
    // plik istnieje i jest pełnym promptem
    const second = tenantConfigFromEnv({ warn() {} }, { defaultPromptFile: path });
    assert.equal(second.promptText, tenant.promptText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt jawny (DOCS_CHAT_PROMPT_FILE): zły plik = fail-closed; dobry = treść deployu", () => {
  assert.throws(
    () => tenantConfigFromEnv({ DOCS_CHAT_PROMPT_FILE: "C:/nie-ma-takiego.md" }, { warn() {} }),
    /cannot read prompt file/
  );
  const file = tmpFile("prompt.md", "Prompt wdrożenia klienta.");
  try {
    const tenant = tenantConfigFromEnv({ DOCS_CHAT_PROMPT_FILE: file.path }, { warn() {} });
    assert.equal(tenant.promptText, "Prompt wdrożenia klienta.");
    assert.equal(tenant.promptFile, file.path, "promptFile = explicit env path");
  } finally {
    file.cleanup();
  }
});

test("prompt default nie do zapisu = warn + prompt z kodu (boot NIE pada)", () => {
  const warnings = [];
  // ścieżka pod plikiem (mkdirSync poleci) — zapis defaultu niemożliwy
  const blocker = tmpFile("blocker.txt", "x");
  try {
    const tenant = tenantConfigFromEnv(
      {},
      { warn: (message) => warnings.push(message), defaultPromptFile: join(blocker.path, "sub", "prompt.md") }
    );
    assert.equal(tenant.promptText, undefined);
    // sciezka niesiona mimo nieudanego zapisu — PUT odda uczciwy blad zapisu zamiast 409
    assert.equal(tenant.promptFile, join(blocker.path, "sub", "prompt.md"), "promptFile carried even when unwritable");
    assert.ok(warnings.some((message) => /cannot ensure the default prompt file/.test(message)));
  } finally {
    blocker.cleanup();
  }
});

test("persona: DOCS_CHAT_PERSONA_FILE przechodzi przez envConfig do rejestru", () => {
  const persona = tmpFile("persona.md", "Jesteś asystentem dokumentacji klienta.");
  try {
    const tenant = tenantConfigFromEnv({ DOCS_CHAT_PERSONA_FILE: persona.path }, { warn() {}, defaultPromptFile: join(tmpdir(), "env-config-x", "prompt.md") });
    assert.equal(tenant.persona, "Jesteś asystentem dokumentacji klienta.");
  } finally {
    persona.cleanup();
  }
});

test("CHAT_MODEL jako fallback legacy, DOCS_CHAT_MODEL wygrywa", () => {
  const df = { warn() {}, defaultPromptFile: join(tmpdir(), "env-config-x", "prompt.md") };
  assert.equal(tenantConfigFromEnv({ CHAT_MODEL: "legacy-model" }, df).model, "legacy-model");
  assert.equal(
    tenantConfigFromEnv({ CHAT_MODEL: "legacy-model", DOCS_CHAT_MODEL: "new-model" }, df).model,
    "new-model"
  );
});
