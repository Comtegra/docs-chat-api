// @ts-check
// Entrypoint serwisu docs-chat-api: asystent dokumentacji (instancja = jeden tenant z env)
// jako osobny proces Node — bez Nexta, panelu admina, newslettera i agenta CVE (separacja od
// strony www). Ten sam kod z lib/*, osobny obraz i instancja.
//
// Uruchomienie: node server/docs-chat-api.mjs   (PORT, HOST; DATABASE_URL; OPENAI_API_KEY —
// reszta ma defaulty, lib/tenants/envConfig.mjs). Klucz importu: generowany przy pierwszym boocie,
// RAW pokazany raz w logu startu, sha256 zapisane do bazy (persist przez recreate).
// Zamknięcie: SIGTERM/SIGINT → stop przyjmowania, dokończenie trwających strumieni (≤ 30 s),
// flush Langfuse per tenant, zamknięcie puli Postgresa.

import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import OpenAI from "openai";
import { verifyGatewayModels } from "../lib/docsChat/llm.mjs";
import { getEmbeddingConfig } from "../lib/embeddings.mjs";

import { tenantConfigFromEnv } from "../lib/tenants/envConfig.mjs";
import { resolveIndexKeyHashes } from "../lib/tenants/indexKeys.mjs";
import { MIGRATIONS_DIR, listMigrationFiles } from "../db/migrate.mjs";
import { runBootMigrations } from "../db/bootMigrate.mjs";
import { LangfuseService } from "../lib/chat/LangfuseService.mjs";
import { closePool, getPool } from "../lib/postgres.mjs";
import { createDocsChatApp } from "../lib/server/app.mjs";
import { createLogger } from "../lib/server/logging.mjs";
import { createTenantRegistry } from "../lib/tenants/registry.mjs";

const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Buduje serwisy per tenant z sekretów rejestru (raz, przy starcie).
 * @param {import("../lib/tenants/registry.mjs").TenantRegistry} registry
 * @param {import("../lib/server/logging.mjs").Logger} logger
 */
function createServices(registry, logger) {
  /** @type {Map<string, { langfuseService: LangfuseService, llmClient: OpenAI }>} */
  const byTenant = new Map();
  for (const tenant of registry.list()) {
    const secrets = registry.secrets(tenant.id);
    const langfuseService = new LangfuseService(
      secrets.langfuse.enabled
        ? {
            enabled: true,
            baseUrl: /** @type {string} */ (secrets.langfuse.baseUrl),
            publicKey: /** @type {string} */ (secrets.langfuse.publicKey),
            secretKey: /** @type {string} */ (secrets.langfuse.secretKey),
          }
        : { enabled: false }
    );
    const llmClient = new OpenAI({ baseURL: secrets.llm.baseUrl, apiKey: secrets.llm.apiKey, maxRetries: 0 });
    byTenant.set(tenant.id, { langfuseService, llmClient });
    // gateway (llmproxy) na nieznany model odpowiada 401 jak na zły klucz — sprawdzamy nazwy na starcie
    verifyGatewayModels({ client: llmClient, expected: [tenant.model, getEmbeddingConfig().model] })
      .then(({ missing, available }) => {
        logger.info("gateway models", { tenant: tenant.id, available });
        if (missing.length > 0) {
          logger.error("gateway does not serve required models", { tenant: tenant.id, missing });
        }
      })
      .catch((error) => {
        logger.warn("gateway model check failed (key/network?)", { tenant: tenant.id, error: error instanceof Error ? error.message : String(error) });
      });
    logger.info("tenant ready", {
      tenant: tenant.id,
      model: tenant.model,
      locales: tenant.locales,
      observability: langfuseService.enabled,
      indexing: secrets.indexKeyHashes.length > 0,
      // "required" bez hashy = czat odpowiada 503 do czasu ustawienia DOCS_CHAT_SITE_TOKENS
      siteToken: tenant.auth.requireSiteToken ? (secrets.siteTokenHashes.length > 0 ? "required" : "required-unconfigured") : "off",
    });
  }
  return byTenant;
}

async function main() {
  const logger = createLogger();
  const env = process.env;
  // konfiguracja z env + defaultów, walidacja fail-closed PRZED migracjami i generowaniem klucza
  const tenant = tenantConfigFromEnv(env, { warn: (message) => logger.warn(message) });
  // walidacja env embeddingów przy starcie (zła EMBEDDING_VECTOR_SIZE = błąd tu, nie przy pierwszym pytaniu)
  const embedding = getEmbeddingConfig(env);
  logger.info("embeddings", { model: embedding.model, vectorSize: embedding.vectorSize });
  // migracje idą same przy starcie (deploy bez kroku „migracje"); błąd = startup failed
  const bootMigrations = await runBootMigrations({ logger });
  // klucz importu: env (rotacja) > baza (persist) > wygenerowany przy pierwszym boocie —
  // RAW pokazany raz w logu; sha256 ląduje w instance_settings i przeżywa recreate compute
  const pool = getPool();
  const indexKeys = await resolveIndexKeyHashes({ env, pool, logger });
  const registry = createTenantRegistry({
    tenants: [tenant],
    env,
    indexKeyHashes: indexKeys.hashes,
    warn: (message) => logger.warn(message),
  });
  const services = createServices(registry, logger);
  const app = createDocsChatApp({
    registry,
    env,
    pool,
    logger,
    // readiness = połączenie + schemat nie starszy niż kod (nowa wersja nie dostaje ruchu, dopóki migracje nie zostaną wykonane)
    migrations: await listMigrationFiles(MIGRATIONS_DIR),
    services: (tenant) => {
      const found = services.get(tenant.id);
      if (!found) throw new Error(`No services for tenant "${tenant.id}"`);
      return found;
    },
  });

  const server = http.createServer((req, res) => {
    void app.handle(req, res);
  });
  // SSE: brak limitu czasu na odpowiedź po stronie serwera HTTP — timeouty ma handler (LLM).
  // Te trzy dotyczą ODBIORU żądania i bezczynnych połączeń, nie odpowiedzi:
  // - keepAliveTimeout 65 s > 60 s upstream keepalive ingress-nginx (inaczej 502 na wyścigu zamknięcia),
  // - headersTimeout > keepAliveTimeout (zalecenie Node),
  // - requestTimeout >= headersTimeout (Node wymaga; slowloris na body i tak kończy się po 90 s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 90_000;

  const port = Number(env.PORT || 3001);
  const host = env.HOST || "0.0.0.0";
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  logger.info("listening", { host, port, tenants: app.tenantIds() });

  let shuttingDown = false;
  /** @param {string} signal */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal, graceMs: SHUTDOWN_GRACE_MS });
    // 1) przestań przyjmować; trwające strumienie kończą się naturalnie albo po grace
    const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
    await Promise.race([closed, sleep(SHUTDOWN_GRACE_MS)]);
    server.closeAllConnections?.();
    // 2) trwające importy → przerwane i oznaczone failed (nie zostają wieczne `pending`)
    // (nie dłużej niż grace: partia embeddingów w toku może trwać do minuty)
    await Promise.race([app.shutdown(), sleep(SHUTDOWN_GRACE_MS)]);
    // 3) flush obserwowalności per tenant — inaczej trace'y z ostatnich sekund giną z podem
    await Promise.allSettled([...services.values()].map(({ langfuseService }) => langfuseService.shutdownAsync()));
    // 4) pula bazy
    await closePool();
    logger.info("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // błąd startu (np. zła konfiguracja tenanta) = proces nie wstaje, platforma nie kieruje ruchu
  console.error(JSON.stringify({ level: "error", msg: "startup failed", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
