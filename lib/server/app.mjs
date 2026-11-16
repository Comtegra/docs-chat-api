// @ts-check
// Aplikacja serwisu docs-chat-api: trasy /api/v1/* zbudowane z rejestru tenantów, bez Nexta.
// Testowalna bez nasłuchu (createDocsChatApp().handle(req, res)). Zależności z zewnątrz (DI):
// pula Postgresa, fabryki serwisów per tenant (Langfuse, klient LLM) — lib nie importuje
// LangfuseService (reguła: moduły z fabrykami nie zależą od obserwowalności).
//
// Trasy (identyczność = instancja — adres hosta niesie wdrożenie, w ścieżce nie ma segmentu tenanta):
//   GET  /metrics                       Prometheus: same liczniki (na platformie CGC dostępny publicznie
//                                       na hoście instancji — bez treści pytań i bez IP)
//   GET  /api/v1/health                 probe: baza + rejestr (LLM nie blokuje)
//   GET  /api/v1/status                 sonda widgetu: model, locale, aktywny indeks, observability
//   POST /api/v1/chat                   SSE (lib/docsChat/handler.mjs); tenant z `auth.requireSiteToken`
//                                       wymaga nagłówka X-Site-Token (401 bez/zły, 503 gdy brak hashy w env)
//   POST /api/v1/feedback               ocena 👍/👎 → Langfuse score (X-Site-Token jak czat)
//   POST /api/v1/index/import                           (Bearer klucz indeksu, ≤ 16 MB) CAŁY korpus jednym
//        wywołaniem: payload jak legacy /api/vdb/createCollection (eksporter cgc-user-docs) albo całe
//        strony {title, text, metadata.route} — serwer dzieli na chunki. 202 {importId}, praca W TLE
//        (embeddingi setek fragmentów nie mieszczą się w 60 s ingressu): pending → chunki → activate
//        (guard 70 %, `force`) | failed. Stan = wiersz document_imports; jeden job na instancję naraz.
//   GET  /api/v1/index/imports/{id}                    (Bearer) stan importu (polling do active/failed)
//   GET  /api/v1/index/imports                          (Bearer) ostatnie importy per locale (rollback)
//   POST /api/v1/index/imports/{id}/activate           (Bearer) atomowy swap; archiwalny = rollback
//   POST /api/v1/index/imports/{id}/abort              (Bearer) wiszący import → failed
//   PUT  /api/v1/admin/prompt                           (Bearer klucz indeksu) podmiana promptu w locie
// Instancja = dokładnie jeden tenant z env (envConfig, fail-closed przy starcie). Nieznana ścieżka → 404;
// zła metoda → 405 z Allow; ścieżka spoza /api/v1 → 404 (pod klienta nie serwuje niczego innego — separacja
// od strony www).

import { applyTenantCorsHeaders } from "../apiGuards.mjs";
import { createDocsChatHandler } from "../docsChat/handler.mjs";
import { createFeedbackHandler } from "../chat/feedbackHandler.mjs";
import { createEmbeddings as createEmbeddingsWithOpenAI } from "../embeddings.mjs";
import { chunkDocument } from "../vdb/chunk.mjs";
import {
  ImportStateError,
  abortImport,
  activateImport,
  appendImportChunks,
  createImport,
  getImport,
  listImports,
  pruneImports,
  validateImportDocuments,
} from "../vdb/imports.mjs";
import { ClientDisconnectedError, HttpError, enhanceResponse, normalizePath, readJsonBody, readTextBody } from "./http.mjs";
import { PromptFileNotConfiguredError, writePromptFile } from "../tenants/promptFile.mjs";
import { authorizeIndexRequest, authorizeSiteToken } from "./indexAuth.mjs";
import { createLogger } from "./logging.mjs";
import { createMetrics } from "./metrics.mjs";
import { createRouter } from "./router.mjs";
import { buildTenantStatus, getHealth } from "./status.mjs";

/** @typedef {import("../tenants/registry.mjs").TenantRegistry} TenantRegistry */
/** @typedef {import("../tenants/registry.mjs").TenantConfig} TenantConfig */

const CHAT_BODY_MAX_BYTES = 64 * 1024;
const FEEDBACK_BODY_MAX_BYTES = 4 * 1024;
const INDEX_SMALL_BODY_MAX_BYTES = 4 * 1024;
// cały korpus eksportera w jednym POST (korpusy ~1–3 MB). Objaw 413 ZANIM
// żądanie dotrze do serwisu = ingress przed nim tnie body (nginx domyślnie 1 MB) — podnieś tam limit.
const INDEX_FULL_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
// sufit rozsądku (korpusy to setki dokumentów): zepsuty eksporter wysyłający dokument per linia
// nie zajmie instancji na godziny embeddingów
const INDEX_MAX_DOCUMENTS = 5000;
const INDEX_MAX_CHUNKS = 20000;

// Admin prompt body: sufit = PROMPT_MAX_CHARS w najgorszym razie 4 bajty/znak UTF-8 + zapas na newline
const PROMPT_BODY_MAX_BYTES = 33 * 1024;

/**
 * @typedef {Object} TenantServices
 * @property {any} langfuseService   instancja per tenant (enabled=false gdy brak kluczy)
 * @property {any} llmClient         klient OpenAI-compatible z sekretów tenanta
 */

/**
 * @param {{
 *   registry: TenantRegistry,
 *   env?: Record<string, string|undefined>,
 *   pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
 *   services: (tenant: TenantConfig) => TenantServices,
 *   logger?: import("./logging.mjs").Logger,
 *   handlerOverrides?: Record<string, unknown>,
 *   metrics?: import("./metrics.mjs").AppMetrics,
 *   indexOverrides?: { createEmbeddings?: (inputs: string[], options?: any) => Promise<number[][]> },
 *   migrations?: string[],
 * }} options
 *   `services` — fabryka wołana raz per tenant przy starcie (Map w bootstrapie).
 *   `handlerOverrides` — wstrzyknięcia do createDocsChatHandler (testy: mock retrieval/LLM/limitów).
 *   `migrations` — nazwy migracji wymagane przez ten kod; health (readiness) zwraca 503, gdy w bazie
 *   ich brakuje (patrz status.mjs getHealth).
 */
export function createDocsChatApp(options) {
  const env = options.env || process.env;
  const logger = options.logger || createLogger();
  const metrics = options.metrics || createMetrics();
  const router = createRouter();
  /** wzorce tras obsługujących tenanta — etykieta metryk/logów zamiast segmentu URL */
  const tenantRoutes = new Set();
  /** @type {Map<string, { chat: Function, feedback: Function, observability: boolean }>} */
  const tenantHandlers = new Map();

  // instancja = dokładnie jeden tenant (envConfig); fail-closed, bo trasy nie mają segmentu
  // tenanta i przy dwóch skonfigurowanych serwis cicho serwowałby pierwszego z listy
  const configured = options.registry.list();
  if (configured.length !== 1) {
    throw new Error(`docs-chat-api serves exactly one tenant per instance (env config); got ${configured.length}`);
  }
  /** @type {TenantConfig} */
  const appTenant = configured[0];

  for (const tenant of configured) {
    const services = options.services(tenant);
    const observability = Boolean(services.langfuseService?.enabled);
    tenantHandlers.set(tenant.id, {
      chat: createDocsChatHandler({
        env,
        tenant,
        llmClient: services.llmClient,
        langfuseService: services.langfuseService,
        onRejection: ({ reason }) => metrics.observeChatRejection({ tenant: tenant.id, reason }),
        ...(options.handlerOverrides || {}),
      }),
      feedback: createFeedbackHandler({
        env,
        tenant,
        langfuseService: services.langfuseService,
        ...(options.handlerOverrides?.checkRateLimit
          ? { checkRateLimit: /** @type {any} */ (options.handlerOverrides.checkRateLimit) }
          : {}),
      }),
      observability,
    });
  }

  /**
   * Jedyny tenant instancji (raz zbudowane handlery).
   * @returns {{ tenant: TenantConfig, handlers: { chat: Function, feedback: Function, observability: boolean } }}
   */
  function theTenant() {
    const handlers = tenantHandlers.get(appTenant.id);
    if (!handlers) {
      throw new HttpError(500, "Tenant handlers not initialized");
    }
    return { tenant: appTenant, handlers };
  }

  router.add("GET", "/metrics", async (req, res) => {
    const exposition = await metrics.expose();
    res.setHeader("Content-Type", exposition.contentType);
    res.status(200).end(exposition.body);
  });

  router.add("GET", "/api/v1/health", async (req, res) => {
    const health = await getHealth({ pool: options.pool, tenantCount: options.registry.list().length, migrations: options.migrations });
    res.setHeader("Cache-Control", "no-store");
    res.status(health.status === "ok" ? 200 : 503).json(health);
  });

  /**
   * Trasa tenanta: rejestracja wzorca + etykieta metryk/logów (bez tego finish() nie zna tenanta).
   * @param {string} method
   * @param {string} pattern
   * @param {import("./router.mjs").RouteHandler} handler
   */
  const addTenantRoute = (method, pattern, handler) => {
    tenantRoutes.add(pattern);
    router.add(method, pattern, handler);
  };

  addTenantRoute("GET", "/api/v1/status", async (req, res) => {
    const { tenant, handlers } = theTenant();
    // sonda widgetu bywa cross-origin — te same reguły CORS, co czat
    const cors = applyTenantCorsHeaders(req, res, tenant.cors.origins);
    if (!cors.allowed) {
      throw new HttpError(403, "Origin not allowed");
    }
    const status = await buildTenantStatus({ tenant, pool: options.pool, observability: handlers.observability });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(status);
  });
  addTenantRoute("OPTIONS", "/api/v1/status", async (req, res) => {
    const { tenant } = theTenant();
    applyTenantCorsHeaders(req, res, tenant.cors.origins);
    res.status(204).end();
  });

  /**
   * Token strony (tenant z `auth.requireSiteToken`): sprawdzany PRZED body i limiterem — odrzut kosztuje
   * jeden sha256, nie zapytanie do bazy. Nagłówki CORS ustawiamy wcześniej, żeby przeglądarka na
   * dozwolonym originie widziała 401 (komunikat w widgecie) zamiast błędu sieci; obcy origin → 403
   * jak w handlerze. Preflight (OPTIONS) nie niesie nagłówków własnych — przechodzi do handlera.
   * @param {any} req
   * @param {any} res
   * @param {TenantConfig} tenant
   */
  function requireSiteToken(req, res, tenant) {
    if (!tenant.auth.requireSiteToken || req.method === "OPTIONS") return;
    const cors = applyTenantCorsHeaders(req, res, tenant.cors.origins);
    if (!cors.allowed) {
      throw new HttpError(403, "Origin not allowed");
    }
    const decision = authorizeSiteToken(req, options.registry.secrets(tenant.id).siteTokenHashes);
    if (decision === "disabled") {
      throw new HttpError(503, "Site token is not configured for this tenant");
    }
    if (decision !== "ok") {
      throw new HttpError(401, decision === "missing" ? "Site token required" : "Invalid site token");
    }
  }

  /** @param {"chat"|"feedback"} kind @param {number} maxBytes */
  const tenantRoute = (kind, maxBytes) => async (/** @type {any} */ req, /** @type {any} */ res) => {
    const { tenant, handlers } = theTenant();
    requireSiteToken(req, res, tenant);
    req.body = await readJsonBody(req, { maxBytes });
    await handlers[kind](req, res);
  };
  addTenantRoute("POST", "/api/v1/chat", tenantRoute("chat", CHAT_BODY_MAX_BYTES));
  addTenantRoute("OPTIONS", "/api/v1/chat", tenantRoute("chat", CHAT_BODY_MAX_BYTES));
  addTenantRoute("POST", "/api/v1/feedback", tenantRoute("feedback", FEEDBACK_BODY_MAX_BYTES));
  addTenantRoute("OPTIONS", "/api/v1/feedback", tenantRoute("feedback", FEEDBACK_BODY_MAX_BYTES));

  // --- indeksowanie (Bearer klucz tenanta) ---

  /**
   * @param {any} req
   * @param {TenantConfig} tenant
   */
  function requireIndexAuth(req, tenant) {
    const decision = authorizeIndexRequest(req, options.registry.secrets(tenant.id).indexKeyHashes);
    if (decision === "disabled") {
      throw new HttpError(503, "Indexing is not enabled for this tenant");
    }
    if (decision !== "ok") {
      throw new HttpError(401, decision === "missing" ? "Bearer token required" : "Invalid index key");
    }
  }

  /**
   * Import należy do tenanta, gdy jego kolekcja jest na liście tenanta — inaczej 404 (nie 403:
   * nie zdradzamy istnienia cudzych importów).
   * @param {TenantConfig} tenant
   * @param {string} importId
   */
  async function requireTenantImport(tenant, importId) {
    const row = await getImport(importId, { pool: options.pool });
    if (!row || !Object.values(tenant.collections).includes(row.collection_name)) {
      throw new HttpError(404, "Import not found");
    }
    return row;
  }

  /**
   * Po udanej aktywacji: sprzątanie starych importów kolekcji w tle (porzucone pending → failed,
   * archiwalne poza ostatnimi 3 i stare failed — usunięte z chunkami). Fire-and-forget: prune
   * nigdy nie blokuje odpowiedzi ani nie dotyka importu aktywnego (znalezisko przeglądu:
   * pruneImports było wyeksportowane, ale nigdzie nie wołane — tabela rosła bez końca).
   * @param {string} collectionName
   * @param {string} language
   * @param {string} tenantId
   */
  function pruneAfterActivate(collectionName, language, tenantId) {
    void pruneImports({ collectionName, language }, { pool: options.pool })
      .then((result) => {
        if (result.expiredPending || result.deletedImports) {
          logger.info("prune", { tenant: tenantId, collection: collectionName, ...result });
        }
      })
      .catch((error) => {
        logger.warn("prune failed", {
          tenant: tenantId,
          collection: collectionName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** @param {unknown} error */
  function rethrowImportError(error) {
    if (error instanceof ImportStateError) {
      throw new HttpError(error.status, error.message);
    }
    if (error instanceof Error && /is required|must be|non-empty/.test(error.message)) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }

  addTenantRoute("GET", "/api/v1/index/imports", async (req, res) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    /** @type {Record<string, unknown[]>} */
    const imports = {};
    for (const locale of tenant.locales) {
      const rows = await listImports({ collectionName: tenant.collections[locale], language: locale }, { pool: options.pool });
      imports[locale] = rows.map(importView);
    }
    res.status(200).json({ tenant: tenant.id, imports });
  });

  addTenantRoute("POST", "/api/v1/index/imports/:importId/activate", async (req, res, params) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    const row = await requireTenantImport(tenant, params.importId);
    const body = /** @type {any} */ (await readJsonBody(req, { maxBytes: INDEX_SMALL_BODY_MAX_BYTES }));
    try {
      const result = await activateImport({ importId: String(row.id), force: body?.force === true }, { pool: options.pool });
      pruneAfterActivate(row.collection_name, row.language, tenant.id);
      res.status(200).json(result);
    } catch (error) {
      rethrowImportError(error);
    }
  });

  addTenantRoute("POST", "/api/v1/index/imports/:importId/abort", async (req, res, params) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    const row = await requireTenantImport(tenant, params.importId);
    const body = /** @type {any} */ (await readJsonBody(req, { maxBytes: INDEX_SMALL_BODY_MAX_BYTES }));
    try {
      const result = await abortImport({ importId: String(row.id), reason: body?.reason }, { pool: options.pool });
      res.status(200).json(result);
    } catch (error) {
      rethrowImportError(error);
    }
  });

  /**
   * @param {TenantConfig} tenant
   */
  function tenantEmbeddings(tenant) {
    const services = options.services(tenant);
    return (
      options.indexOverrides?.createEmbeddings ||
      // timeout per partia: bez niego SDK czeka do 10 min × ponowienia, a shutdown/abort działa dopiero między partiami
      ((/** @type {string[]} */ inputs) => createEmbeddingsWithOpenAI(inputs, { client: services.llmClient, env, requestOptions: { timeout: 60_000 } }))
    );
  }

  /** @param {import("../vdb/imports.mjs").ImportRow} row */
  const importView = (row) => ({
    importId: String(row.id),
    status: row.status,
    documents: Number(row.total_documents || 0),
    commitSha: row.commit_sha,
    source: row.source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    activatedAt: row.activated_at instanceof Date ? row.activated_at.toISOString() : row.activated_at,
    error: row.error,
  });

  addTenantRoute("GET", "/api/v1/index/imports/:importId", async (req, res, params) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    const row = await requireTenantImport(tenant, params.importId);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(importView(row));
  });

  // --- indeksowanie w tle ---
  /** @type {Map<string, { importId: string, controller: AbortController, done: Promise<void> }>} */
  const runningJobs = new Map();
  // partia = jedna transakcja wstawiania (embeddingi liczone przed nią); mała, żeby log pokazywał postęp
  const INDEX_JOB_BATCH = 50;

  /**
   * Przebieg indeksowania w tle: dokumenty → chunki (dzieli serwer; już podzielone przechodzą bez
   * zmian) → partie z embeddingami kluczem tenanta → aktywacja (guard 70 %, `force`) → prune.
   * Błąd na dowolnym etapie = import `failed` z powodem.
   * @param {TenantConfig} tenant
   * @param {{ importId: string, locale: string, force: boolean }} job
   * @param {AbortController} controller  utworzony przy REZERWACJI slotu (route) — shutdown
   *   przerywa pracę także w oknie między rezerwacją a startem
   * @param {import("../vdb/imports.mjs").ImportDocument[]} documents
   */
  async function runIndexJob(tenant, job, controller, documents) {
    const log = (/** @type {string} */ message) => logger.info("import", { tenant: tenant.id, importId: job.importId, message });
    const done = (async () => {
      try {
        const chunks = documents.flatMap((document) => chunkDocument(document));
        log(`documents: ${documents.length}, chunks: ${chunks.length}`);
        if (chunks.length > INDEX_MAX_CHUNKS) throw new Error(`Import produced ${chunks.length} chunks (limit ${INDEX_MAX_CHUNKS})`);
        const createEmbeddings = tenantEmbeddings(tenant);
        for (let offset = 0; offset < chunks.length; offset += INDEX_JOB_BATCH) {
          if (controller.signal.aborted) throw new Error("Import aborted (shutdown)");
          await appendImportChunks(
            { importId: job.importId, documents: chunks.slice(offset, offset + INDEX_JOB_BATCH) },
            { pool: options.pool, createEmbeddings }
          );
        }
        const activated = await activateImport({ importId: job.importId, force: job.force }, { pool: options.pool });
        log(`active: ${activated.documents} chunks`);
        pruneAfterActivate(tenant.collections[job.locale], job.locale, tenant.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error("import failed", { tenant: tenant.id, importId: job.importId, error: reason });
        try {
          await abortImport({ importId: job.importId, reason }, { pool: options.pool });
        } catch (abortError) {
          logger.error("import abort failed", { tenant: tenant.id, importId: job.importId, error: abortError instanceof Error ? abortError.message : String(abortError) });
        }
      } finally {
        runningJobs.delete(tenant.id);
      }
    })();
    runningJobs.set(tenant.id, { importId: job.importId, controller, done });
    return done;
  }

  /**
   * Rezerwuje slot indeksowania tenanta (jeden job naraz) i zakłada import
   * `pending`. Zwraca importId; zwolnienie slotu przy błędzie, żeby 409 nie zostało na zawsze.
   * @param {TenantConfig} tenant
   * @param {{ collectionName: string, locale: string, source: string|null|undefined, commitSha: unknown }} input
   * @param {import("node:http").ServerResponse & { setHeader: Function }} res
   */
  async function reserveIndexJob(tenant, input, res) {
    const running = runningJobs.get(tenant.id);
    if (running) {
      res.setHeader("Retry-After", "60");
      throw new HttpError(
        409,
        `An index job is already running for this tenant${running.importId ? ` (import ${running.importId})` : ""}`
      );
    }
    // REZERWACJA slotu przed pierwszym await: dwa równoległe żądania w tym samym procesie nie
    // przejdą obie przez guard (znalezisko przeglądu). Wyścig między replikami domyka indeks
    // 003 (drugi createImport → 23505 → 409). Ten sam controller obowiązuje od rezerwacji.
    const controller = new AbortController();
    runningJobs.set(tenant.id, { importId: "", controller, done: Promise.resolve() });
    try {
      const created = await createImport(
        { collectionName: input.collectionName, language: input.locale, source: input.source, commitSha: typeof input.commitSha === "string" ? input.commitSha : undefined },
        { pool: options.pool }
      );
      return { importId: created.importId, controller };
    } catch (error) {
      runningJobs.delete(tenant.id);
      rethrowImportError(error);
      throw error; // nieosiągalne (rethrowImportError zawsze rzuca) — dla kontroli przepływu TS
    }
  }

  /**
   * Locale i kolekcja z żądania, zawsze zweryfikowane względem tenanta: `collectionName` (payload
   * eksportera) musi być jedną z kolekcji tenanta, inaczej `locale` (domyślnie defaultLocale).
   * @param {TenantConfig} tenant
   * @param {any} body
   */
  function resolveIndexTarget(tenant, body) {
    const requestedCollection = typeof body?.collectionName === "string" ? body.collectionName.trim() : "";
    if (requestedCollection) {
      const entry = Object.entries(tenant.collections).find(([, name]) => name === requestedCollection);
      if (!entry) {
        throw new HttpError(400, `collectionName must be one of: ${Object.values(tenant.collections).join(", ")}`);
      }
      return { locale: entry[0], collectionName: requestedCollection };
    }
    const locale = String(body?.locale || tenant.defaultLocale).toLowerCase();
    const collectionName = tenant.collections[locale];
    if (!collectionName) {
      throw new HttpError(400, `locale must be one of: ${tenant.locales.join(", ")}`);
    }
    return { locale, collectionName };
  }

  // --- import z eksportera (jak cgc-user-docs: markdown z repo → JSON → POST przy tagu) ---
  // Payload jak legacy /api/vdb/createCollection: {collectionName | locale, source, commitSha,
  // data:[{title,text,file_path?,metadata?}]}. Dokument = cała strona (serwer dzieli na chunki) albo
  // gotowy chunk (metadata.chunked). Różnice wobec legacy: klucz indeksowania tenanta zamiast
  // globalnego, kolekcja weryfikowana względem tenanta, embeddingi kluczem LLM tenanta, walidacja
  // PRZED 202 (zły payload nie zakłada importu), aktywacja z guardem 70 % — `{"force":true}` wyłącza
  // guard. Eksporter polluje GET …/index/imports/{importId} do `active`/`failed`.
  addTenantRoute("POST", "/api/v1/index/import", async (req, res) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    const body = /** @type {any} */ (await readJsonBody(req, { maxBytes: INDEX_FULL_IMPORT_MAX_BYTES }));
    const { locale, collectionName } = resolveIndexTarget(tenant, body);
    /** @type {import("../vdb/imports.mjs").ImportDocument[]} */
    let documents;
    try {
      documents = validateImportDocuments(body?.data);
    } catch (error) {
      rethrowImportError(error);
      throw error;
    }
    if (documents.length > INDEX_MAX_DOCUMENTS) {
      throw new HttpError(400, `data must contain at most ${INDEX_MAX_DOCUMENTS} documents (got ${documents.length})`);
    }
    const source = typeof body?.source === "string" && body.source.trim() ? `import:${body.source.trim()}` : `import:${tenant.id}`;
    const { importId, controller } = await reserveIndexJob(tenant, { collectionName, locale, source, commitSha: body?.commitSha }, res);
    void runIndexJob(tenant, { importId, locale, force: body?.force === true }, controller, documents);
    res.status(202).json({ importId, collection: collectionName, locale, documents: documents.length });
  });

  // --- admin prompt (Bearer klucz indeksu — ten sam sekret co import, jeden knob na instancję) ---
  //
  // PUT /api/v1/admin/prompt, Content-Type: text/plain, body = PEŁNA treść prompt.md
  // (default zasady + persona — nadpisuje całość, jak ręczna edycja pliku). Kolejność fail-closed:
  // walidacja PRZED zapisem (zły prompt nie nadpisuje działającego pliku) → zapis do
  // tenant.promptFile (ścieżka rozwiązana przy starcie: jawny env albo default na wolumenie —
  // jedno źródło prawdy, restart ładuje to samo) → live-apply (handler czyta promptText
  // z tenanta per request, więc nowy obowiązuje od następnego pytania). Brak pliku w tenancie
  // (inline) = 409; env-config tenant ma plik zawsze (default tworzony przy 1. boocie).
  addTenantRoute("PUT", "/api/v1/admin/prompt", async (req, res) => {
    const { tenant } = theTenant();
    requireIndexAuth(req, tenant);
    const raw = await readTextBody(req, { maxBytes: PROMPT_BODY_MAX_BYTES, contentType: "text/plain" });
    let promptText;
    try {
      // ścieżka z tenanta (envConfig rozwiązał przy starcie) — admin pisze tam, gdzie start czytał;
      // 409 tylko dla tenantów bez pliku promptu (inline; env-config niesie default zawsze)
      promptText = await writePromptFile(raw, { promptFile: tenant.promptFile });
    } catch (error) {
      if (error instanceof PromptFileNotConfiguredError) {
        throw new HttpError(409, error.message);
      }
      throw new HttpError(400, String(error instanceof Error ? error.message : error));
    }
    // live-apply: obiekt tenanta z rejestru (handler ma tę samą referencję w retrievalOptions)
    tenant.promptText = promptText;
    logger.info("admin prompt updated", { tenant: tenant.id, chars: promptText.length });
    res.status(200).json({ ok: true, tenant: tenant.id, chars: promptText.length, applied: "live" });
  });

  /**
   * Zamknięcie: przerwij trwające importy (→ failed) i poczekaj, aż się rozliczą.
   */
  async function shutdown() {
    for (const job of runningJobs.values()) job.controller.abort();
    await Promise.allSettled([...runningJobs.values()].map((job) => job.done));
  }

  /**
   * Punkt wejścia dla http.createServer. Nigdy nie rzuca: każdy błąd kończy się odpowiedzią
   * (albo, po wysłaniu nagłówków SSE, zamknięciem strumienia) i wpisem w logu.
   * @param {import("node:http").IncomingMessage} rawReq
   * @param {import("node:http").ServerResponse} rawRes
   */
  async function handle(rawReq, rawRes) {
    const startedAt = process.hrtime.bigint();
    const res = enhanceResponse(rawRes);
    const req = /** @type {any} */ (rawReq);
    const method = String(req.method || "GET").toUpperCase();
    const path = normalizePath(req.url);
    /** @type {string|undefined} */
    let tenantId;

    /** @type {string} */
    let routePattern = "(unmatched)";
    const finish = (/** @type {Record<string, unknown>} */ extra = {}) => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (routePattern === "/metrics") return; // scrape nie zaśmieca ani metryk (5xx-ratio), ani logów
      // etykieta = WZORZEC trasy, nie surowa ścieżka (kardynalność metryk)
      metrics.observeRequest({
        method,
        route: routePattern,
        status: res.statusCode,
        tenant: tenantId || "",
        durationMs,
      });
      logger.info("request", {
        method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ...(tenantId ? { tenant: tenantId } : {}),
        ...extra,
      });
    };

    try {
      if (!path) {
        throw new HttpError(400, "Invalid path");
      }
      const match = router.match(method, path);
      if (!match) {
        throw new HttpError(404, "Not found");
      }
      if (!match.handler || !match.params) {
        res.setHeader("Allow", (match.allowed || []).join(", "));
        throw new HttpError(405, "Method not allowed");
      }
      routePattern = match.pattern || "(unmatched)";
      // etykieta tenanta = jedyny skonfigurowany tenant, tylko dla jego tras; 404 (unmatched) nie niesie
      // etykiety — nie ma już segmentu tenanta w URL, więc nie ma czego „nie poznać"
      tenantId = tenantRoutes.has(routePattern) ? appTenant.id : undefined;
      await match.handler(req, res, match.params);
      if (!res.writableEnded && !res.headersSent) {
        // handler nic nie wysłał — błąd programisty, nie wieszamy klienta
        res.status(500).json({ error: "Handler produced no response" });
      }
      finish();
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        // nie ma komu odpowiadać; 499 (konwencja nginx „client closed request") w logu i metrykach,
        // żeby zerwane uploady nie liczyły się jako awarie serwera
        res.statusCode = 499;
        finish({ error: error.message });
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "Internal server error";
      if (status >= 500) {
        logger.error("unhandled", { method, path, error: error instanceof Error ? error.message : String(error) });
      }
      if (!res.headersSent) {
        res.status(status).json({ error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
      finish({ error: message });
    }
  }

  return {
    handle,
    shutdown,
    tenantIds: () => [...tenantHandlers.keys()],
    /** testy: czekanie na import w tle */
    awaitIndexJobs: () => Promise.allSettled([...runningJobs.values()].map((job) => job.done)),
  };
}
