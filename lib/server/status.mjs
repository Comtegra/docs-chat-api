// @ts-check
// Health (probe'y k8s) i status tenanta (sonda widgetu + „która wersja dokumentacji jest
// zaindeksowana"). Health NIE zależy od LLM: awaria modelu nie ma wyrzucać podów z ruchu.

/** @typedef {import("../tenants/registry.mjs").TenantConfig} TenantConfig */
/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} QueryPool */

/** ostatnio zalogowany zestaw brakujących migracji (deduplikacja logu między sondami) */
let lastMissingLogged = "";

/**
 * @param {{ pool: QueryPool, tenantCount: number, timeoutMs?: number, migrations?: string[] }} input
 *   `migrations` — nazwy plików z db/migrations (obraz niesie je razem z kodem), które MUSZĄ być
 *   odnotowane w `schema_migrations`. Brakująca = schemat w tyle za kodem → readiness 503, więc
 *   przy rolloutcie nowy pod nie dostaje ruchu, dopóki migracje nie zostaną wykonane (bez tego pod
 *   z kodem pod migrację 0NN wchodził do ruchu na starym schemacie i sypał 500). Bez listy
 *   (testy, inne procesy) health sprawdza tylko połączenie.
 * @returns {Promise<{ status: "ok"|"error", checks: { database: "ok"|"error", schema?: "ok"|"behind", tenants: number }, error?: string }>}
 */
export async function getHealth(input) {
  const timeoutMs = input.timeoutMs ?? 2000;
  const expected = input.migrations ?? [];
  // Timer MUSI być czyszczony, a nie `unref`-owany: przy `unref` pętla zdarzeń bez innych zadań
  // kończy się przed odpaleniem timera i cała obietnica nigdy się nie rozstrzyga (zawieszony
  // health check). W serwisie maskował to nasłuchujący serwer HTTP; widać to dopiero w testach.
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
  const withTimeout = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database check timed out")), timeoutMs);
      }),
    ]);
  try {
    if (expected.length === 0) {
      await withTimeout(input.pool.query("SELECT 1"));
      return { status: "ok", checks: { database: "ok", tenants: input.tenantCount } };
    }
    /** @type {Set<string>} */
    let applied;
    try {
      const result = await withTimeout(input.pool.query("SELECT name FROM schema_migrations"));
      applied = new Set(result.rows.map((row) => String(row.name)));
    } catch (error) {
      // 42P01 undefined_table: baza sprzed pierwszego uruchomienia runnera (np. baza www przed
      // pierwszym uruchomieniem runnera) — to „schemat w tyle", nie awaria połączenia
      if (/** @type {any} */ (error)?.code !== "42P01") throw error;
      applied = new Set();
    }
    const missing = expected.filter((name) => !applied.has(name));
    if (missing.length > 0) {
      // readiness pyta co 10 s per pod — logujemy przy ZMIANIE zestawu braków, nie przy każdej sondzie
      const key = missing.join(",");
      if (key !== lastMissingLogged) {
        lastMissingLogged = key;
        console.error(`health: schema behind code, missing migrations: ${missing.join(", ")} (run node db/migrate.mjs)`);
      }
      return {
        status: "error",
        checks: { database: "ok", schema: "behind", tenants: input.tenantCount },
        error: "schema behind: pending migrations",
      };
    }
    lastMissingLogged = "";
    return { status: "ok", checks: { database: "ok", schema: "ok", tenants: input.tenantCount } };
  } catch (error) {
    // szczegóły (host bazy, rola, kod pg) TYLKO do logu — trasa jest publiczna pod /api/v1
    console.error("health: database check failed:", error instanceof Error ? error.message : String(error));
    return {
      status: "error",
      checks: { database: "error", tenants: input.tenantCount },
      error: "database check failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {Object} IndexStatus
 * @property {string} locale
 * @property {string} collection
 * @property {string|null} importId
 * @property {string|null} commitSha
 * @property {string|null} activatedAt  ISO 8601
 * @property {number} documents
 * @property {string|null} embeddingModel  stempel z importu — rozjazd z EMBEDDING_MODEL env = czerwona flaga
 */

/**
 * Aktywny import per locale tenanta (document_imports.status = 'active').
 * @param {{ tenant: TenantConfig, pool: QueryPool }} input
 * @returns {Promise<IndexStatus[]>}
 */
export async function getTenantIndexStatus(input) {
  const { tenant, pool } = input;
  /** @type {IndexStatus[]} */
  const statuses = [];
  for (const locale of tenant.locales) {
    const collection = tenant.collections[locale];
    const result = await pool.query(
      `
        SELECT id, commit_sha, activated_at, total_documents, embedding_model
        FROM document_imports
        WHERE collection_name = $1
          AND language = $2
          AND status = 'active'
        ORDER BY activated_at DESC NULLS LAST
        LIMIT 1
      `,
      [collection, locale.toUpperCase()]
    );
    const row = result.rows[0];
    statuses.push({
      locale,
      collection,
      importId: row?.id ?? null,
      commitSha: row?.commit_sha ?? null,
      activatedAt: row?.activated_at instanceof Date ? row.activated_at.toISOString() : row?.activated_at ?? null,
      documents: Number(row?.total_documents || 0),
      embeddingModel: row?.embedding_model ?? null,
    });
  }
  return statuses;
}

/**
 * Odpowiedź GET /api/v1/status — publiczna, bez sekretów. `auth.siteToken` mówi klientowi
 * (widget, aplikacja kliencka), czy czat wymaga nagłówka X-Site-Token — sam token nigdy tu nie trafia.
 * @param {{ tenant: TenantConfig, pool: QueryPool, observability: boolean }} input
 */
export async function buildTenantStatus(input) {
  const index = await getTenantIndexStatus({ tenant: input.tenant, pool: input.pool });
  return {
    tenant: input.tenant.id,
    name: input.tenant.name,
    model: input.tenant.model,
    locales: input.tenant.locales,
    observability: input.observability,
    auth: { siteToken: Boolean(input.tenant.auth?.requireSiteToken) },
    index,
  };
}
