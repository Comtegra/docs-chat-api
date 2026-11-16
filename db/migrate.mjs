// @ts-check
// Runner migracji SQL (db/migrations/NNN_nazwa.sql) z tabelą schema_migrations.
//
// Do tej pory pliki były aplikowane ręcznie `psql -f` (README). Ten runner:
// - aplikuje każdy niezastosowany plik w kolejności nazw, każdy w osobnej transakcji,
//   i zapisuje nazwę w schema_migrations — drugi run nic nie robi;
// - `--baseline`: dla baz zmigrowanych ręcznie (prod/dev CGC) oznacza WSZYSTKIE obecne pliki
//   jako zastosowane bez uruchamiania (migracje 003–011 mają ALTER TABLE bez IF NOT EXISTS,
//   więc ponowne wykonanie by padło). Wykonać raz przed pierwszym prawdziwym runem;
// - `--dry-run`: wypisuje, co zostałoby zastosowane.
//
// Użycie: DATABASE_URL=… node db/migrate.mjs [--baseline] [--dry-run]
//
// Ograniczenie (świadome): pliki nie mogą używać CREATE INDEX CONCURRENTLY (nie działa
// w transakcji). Obecne migracje go nie używają.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATION_FILE = /^\d{3,}_[a-z0-9_]+\.sql$/;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, release?: () => void }} QueryClient
 * @typedef {{ query: QueryClient["query"], connect: () => Promise<QueryClient & { release: () => void }> }} MigrationPool
 */

/** Katalog migracji — także dla health checku serwisu (schemat vs kod, lib/server/status.mjs). */
/** stały klucz blokady doradczej runnera (int8; dowolna unikalna liczba w tej bazie) */
const MIGRATION_LOCK_KEY = 7_204_001;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Nazwy plików migracji w kolejności wykonania.
 * @param {string} dir
 */
export async function listMigrationFiles(dir) {
  const entries = await fs.readdir(dir);
  const files = entries.filter((name) => name.endsWith(".sql"));
  const invalid = files.filter((name) => !MIGRATION_FILE.test(name));
  if (invalid.length > 0) {
    throw new Error(`Migration file names must match NNN_snake_case.sql: ${invalid.join(", ")}`);
  }
  return files.sort();
}

/**
 * @param {MigrationPool} pool
 */
async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      baseline boolean NOT NULL DEFAULT false
    )
  `);
}

/**
 * @param {MigrationPool} pool
 * @returns {Promise<Set<string>>}
 */
async function appliedMigrations(pool) {
  const result = await pool.query("SELECT name FROM schema_migrations");
  return new Set(result.rows.map((row) => String(row.name)));
}

/**
 * @param {{
 *   pool: MigrationPool,
 *   dir?: string,
 *   baseline?: boolean,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function runMigrations(options) {
  if (options.dryRun) {
    return planAndRun(options);
  }
  // Dwa równoległe runnery (np. dwa `kubectl exec` naraz) wchodziły sobie w drogę:
  // drugi padał na `duplicate key … pg_type_typname_nsp_index` w połowie. Blokada sesyjna na
  // dedykowanym kliencie trzymana przez cały przebieg — migracje idą na osobnych klientach puli.
  // runner potrzebuje DWÓCH klientów puli (blokada + transakcja migracji): PG_POOL_MAX=1 = timeout
  const lockClient = await options.pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    return await planAndRun(options);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

/** @param {Parameters<typeof runMigrations>[0]} options */
async function planAndRun(options) {
  const { pool } = options;
  const dir = options.dir || MIGRATIONS_DIR;
  const log = options.log || ((message) => console.info(message));

  await ensureMigrationsTable(pool);
  const files = await listMigrationFiles(dir);
  const applied = await appliedMigrations(pool);

  if (applied.size === 0 && !options.baseline) {
    // Auto-baseline: pusta historia migracji + istniejący schemat serwisu (document_chunks) = baza
    // wywodzi się sprzed runnera → WSZYSTKIE obecne pliki oznaczamy jako applied bez wykonania
    // (idempotentność migracji nie jest kontraktem; rękodzieło na żywej bazie rozstrzyga człowiek).
    // Świeża baza nie ma document_chunks → normalny przebieg.
    const probes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('document_chunks')"
    );
    if (probes.rows.length > 0) {
      log(
        `auto-baseline: schema_migrations is empty but the schema exists — marking ${files.length} migration(s) as applied without running them`
      );
      for (const name of files) {
        if (options.dryRun) {
          log(`[dry-run] baseline ${name}`);
        } else {
          await pool.query(
            "INSERT INTO schema_migrations (name, baseline) VALUES ($1, true) ON CONFLICT (name) DO NOTHING",
            [name]
          );
        }
        // także w dry-run: dalsza część raportu ma przewidywać realny przebieg
        // (bez tego te same pliki liczyły się drugi raz jako "apply")
        applied.add(name);
      }
    }
  }

  const pending = files.filter((name) => !applied.has(name));
  const skipped = files.filter((name) => applied.has(name));

  if (options.baseline) {
    for (const name of pending) {
      if (options.dryRun) {
        log(`[dry-run] baseline ${name}`);
        continue;
      }
      await pool.query(
        "INSERT INTO schema_migrations (name, baseline) VALUES ($1, true) ON CONFLICT (name) DO NOTHING",
        [name]
      );
      log(`baseline ${name}`);
    }
    return { applied: pending, skipped };
  }

  for (const name of pending) {
    const sql = await fs.readFile(path.join(dir, name), "utf8");
    if (options.dryRun) {
      log(`[dry-run] apply ${name}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // DDL na bazie współdzielonej ze stroną www: czekanie na blokadę (np. ALTER TABLE za długim
      // zapytaniem www) kolejkowałoby za sobą wszystkie zapytania strony — lepiej paść głośno i powtórzyć
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      log(`applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return { applied: pending, skipped };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  // MIGRATE_DATABASE_URL: opcjonalnie osobna rola z prawami DDL; bez niej DATABASE_URL (na CGC
  // serwis i migracje używają tego samego konta bazy).
  if (process.env.MIGRATE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
  }
  // DDL bez limitu czasu: `kubectl exec` dziedziczy env instancji (PG_STATEMENT_TIMEOUT_MS=15000),
  // a np. zmiana typu kolumny wektorów (004) na dużej tabeli albo czekanie na blokadę trwa dłużej
  delete process.env.PG_STATEMENT_TIMEOUT_MS;
  const { getPool, closePool } = await import("../lib/postgres.mjs");
  const pool = /** @type {MigrationPool} */ (/** @type {unknown} */ (getPool()));
  try {
    const dryRun = args.has("--dry-run");
    const result = await runMigrations({
      pool,
      baseline: args.has("--baseline"),
      dryRun,
    });
    const verb = args.has("--baseline") ? "baselined" : "applied";
    console.info(
      `migrations: ${result.applied.length} ${dryRun ? `would be ${verb} (dry run)` : verb}, ${result.skipped.length} already applied`
    );
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
