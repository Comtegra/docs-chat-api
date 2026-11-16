import pg from "pg";

const { Pool } = pg;

let pool;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/**
 * Dodatnia liczba całkowita z env albo wartość domyślna; śmieciowa wartość = błąd konfiguracji,
 * a nie ciche „jakoś działa" (zła liczba w `PG_*` przy pierwszym zapytaniu, nie po godzinie).
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @param {number|undefined} fallback
 * @returns {number|undefined}
 */
function positiveIntFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/**
 * Konfiguracja puli z env — czysta funkcja, testowana bez bazy.
 * - PG_POOL_MAX: połączeń per proces (domyślne pg = 10). Przy N replikach API łączna liczba
 *   = N × PG_POOL_MAX — zestawić z limitem instancji Postgresa (plan wielodostępu §3.4).
 * - PG_CONNECT_TIMEOUT_MS: ile czekać na wolne połączenie z puli / nawiązanie połączenia
 *   (domyślne pg = bez limitu: przy wyczerpanej puli albo martwej bazie żądania wisiały
 *   w nieskończoność, a strumień SSE bez nagłówków — aż do timeoutu ingressu).
 * - PG_STATEMENT_TIMEOUT_MS: `statement_timeout` sesji (serwer przerywa zbyt długie zapytanie;
 *   bez tego porzucone zapytanie health checku trzymało klienta puli do końca stalla bazy).
 *   Bez wartości domyślnej: runner migracji korzysta z tej samej puli i sam usuwa tę zmienną
 *   z env (DDL bez limitu); limit dotyczy instancji serwisu.
 * @param {Record<string, string|undefined>} env
 */
export function poolConfigFromEnv(env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const max = positiveIntFromEnv(env, "PG_POOL_MAX", undefined);
  const statementTimeout = positiveIntFromEnv(env, "PG_STATEMENT_TIMEOUT_MS", undefined);
  return {
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: positiveIntFromEnv(env, "PG_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    ...(max ? { max } : {}),
    ...(statementTimeout ? { statement_timeout: statementTimeout } : {}),
  };
}

export function getPool() {
  if (!pool) {
    pool = new Pool(poolConfigFromEnv(process.env));
    // pg-pool emituje 'error' puli dla BEZCZYNNEGO klienta (restart/failover Postgresa, zabicie
    // sesji po stronie serwera, zerwanie sieci). Bez listenera to niezłapane zdarzenie 'error'
    // = crash procesu i zerwanie wszystkich strumieni naraz, na wszystkich replikach jednocześnie.
    // Pula sama odrzuca zepsutego klienta — wystarczy zalogować (znalezisko przeglądu przed MR).
    pool.on("error", (error) => {
      console.error("postgres: idle client error:", error instanceof Error ? error.message : String(error));
    });
  }

  return pool;
}

export async function closePool() {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

export async function withTransaction(callback, transactionPool = getPool()) {
  const client = await transactionPool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function assertVectorSize(values, expectedSize) {
  if (!Array.isArray(values) || values.length !== expectedSize) {
    throw new Error(
      `Expected embedding dimension ${expectedSize}, received ${
        Array.isArray(values) ? values.length : "non-array"
      }`
    );
  }
}

export function toVectorLiteral(values) {
  if (!Array.isArray(values)) {
    throw new Error("Vector must be an array");
  }

  return `[${values
    .map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Vector values must be finite numbers");
      }

      return String(value);
    })
    .join(",")}]`;
}
