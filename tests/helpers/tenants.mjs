// @ts-check
// Fixture'y tenantów dla testów — konfiguracja przychodzi z env (envConfig); testy budują
// tenantów inline (paritet z dawnym TENANT_CONFIG_FILE). homeTenant odpowiada kształtowi
// wdrożenia domowego (Ask CGC), syntheticTenant — wdrożenia z NAT-em (site-token, CORS *).
import { positiveIntegerFromEnv, splitList } from "../../lib/tenants/env.mjs";

/**
 * @param {Record<string, string|undefined>} env
 * @returns {import("../../lib/tenants/registry.mjs").TenantConfig}
 */
export function homeTenant(env = {}) {
  return {
    id: "cgc",
    name: "Ask CGC",
    organization: "Comtegra GPU Cloud",
    siteUrl: (env.DOCS_SITE_URL || "https://docs.cgc.comtegra.cloud").replace(/\/+$/, ""),
    locales: ["en", "pl"],
    defaultLocale: "en",
    collections: { en: "cgc-docs-en", pl: "cgc-docs-pl" },
    cors: {
      origins: splitList(env.DOCS_CHAT_ALLOWED_ORIGINS, ["https://docs.cgc.comtegra.cloud", "https://cgc.comtegra.cloud"]),
    },
    limits: {
      perIp: {
        max: positiveIntegerFromEnv(env.DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS, 20),
        windowSeconds: positiveIntegerFromEnv(env.DOCS_CHAT_RATE_LIMIT_WINDOW_SECONDS, 600),
      },
      perIpDaily: positiveIntegerFromEnv(env.DOCS_CHAT_PER_IP_DAILY_LIMIT, 200),
      maxConcurrentPerIp: positiveIntegerFromEnv(env.DOCS_CHAT_MAX_CONCURRENT_PER_IP, 5),
      maxOutputTokens: positiveIntegerFromEnv(env.DOCS_CHAT_MAX_OUTPUT_TOKENS, 1500),
    },
    model: env.DOCS_CHAT_MODEL || env.CHAT_MODEL || "gemma-4-26b-a4b",
    retrieval: { vectorWeight: 0.3, textWeight: 0.7, limit: 5 },
    llm: { requireOwnKey: false },
    auth: { requireSiteToken: false },
    langfuse: { enabled: true, project: "shared" },
    // inline tenant: sciezka promptu tylko z jawnego env (bez env = brak pliku = PUT 409);
    // env-config tenant (prod) niesie promptFile zawsze (default z promptFile.mjs)
    promptFile: env.DOCS_CHAT_PROMPT_FILE,
  };
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {import("../../lib/tenants/registry.mjs").TenantConfig}
 */
export function syntheticTenant(env = {}) {
  return {
    id: "tst",
    name: "Test Assistant",
    organization: "Test",
    siteUrl: (env.TENANT_TST_SITE_URL || "https://docs.tst.example").replace(/\/+$/, ""),
    locales: ["pl"],
    defaultLocale: "pl",
    collections: { pl: "tst-docs-pl" },
    cors: { origins: splitList(env.TENANT_TST_EXTRA_ORIGINS, ["*"]) },
    limits: {
      perIp: {
        max: positiveIntegerFromEnv(env.TENANT_TST_RATE_LIMIT_MAX_REQUESTS, 60),
        windowSeconds: positiveIntegerFromEnv(env.TENANT_TST_RATE_LIMIT_WINDOW_SECONDS, 600),
      },
      perIpDaily: positiveIntegerFromEnv(env.TENANT_TST_PER_IP_DAILY_LIMIT, 300),
      maxConcurrentPerIp: positiveIntegerFromEnv(env.TENANT_TST_MAX_CONCURRENT_PER_IP, 5),
      maxOutputTokens: positiveIntegerFromEnv(env.TENANT_TST_MAX_OUTPUT_TOKENS, 1500),
    },
    model: env.TENANT_TST_MODEL || "gemma-4-26b-a4b",
    retrieval: { vectorWeight: 0.6, textWeight: 0.4, limit: 5 },
    llm: { requireOwnKey: true },
    auth: { requireSiteToken: true },
    langfuse: { enabled: true, project: "own" },
  };
}
