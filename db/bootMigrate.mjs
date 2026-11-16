// @ts-check
// Migracje przy starcie serwisu — produkt nie ma kroju „migracje": deploy = compute + port
// Pula migracji powstaje BEZ PG_STATEMENT_TIMEOUT_MS (jak CLI db/migrate.mjs:
// DDL nie mieści się w 15 s sesji serwisu), po przebiegu jest zamykana i serwis tworzy własną
// pulę z pełnym env. Równoległe starty serialize'uje advisory lock runnera; bazy sprzed runnera
// auto-baseline'uje planAndRun (db/migrate.mjs). Fail-closed: błąd migracji = startup failed —
// platforma nie kieruje ruchu do instancji bez schematu.
import { closePool, getPool } from "../lib/postgres.mjs";
import { runMigrations } from "./migrate.mjs";

/**
 * @param {{
 *   logger: import("../lib/server/logging.mjs").Logger,
 *   env?: Record<string, string|undefined>,
 *   deps?: { runMigrations?: typeof runMigrations, getPool?: typeof getPool, closePool?: typeof closePool },
 * }} options
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function runBootMigrations({ logger, env = process.env, deps = {} }) {
  const migrate = deps.runMigrations || runMigrations;
  const getPoolFn = deps.getPool || getPool;
  const closePoolFn = deps.closePool || closePool;
  const savedTimeout = env.PG_STATEMENT_TIMEOUT_MS;
  delete env.PG_STATEMENT_TIMEOUT_MS;
  try {
    const result = await migrate({ pool: getPoolFn(), log: (message) => logger.info("migrate", { message }) });
    logger.info("migrations", { applied: result.applied.length, already: result.skipped.length });
    return result;
  } finally {
    await closePoolFn();
    if (savedTimeout !== undefined) {
      env.PG_STATEMENT_TIMEOUT_MS = savedTimeout;
    }
  }
}
