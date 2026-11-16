import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listMigrationFiles, runMigrations } from "../db/migrate.mjs";

function fakePool({ applied = [], schemaExists = false } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push({ scope: "client", sql: sql.trim(), params });
      return { rows: [] };
    },
    release() {
      log.push({ scope: "client", sql: "RELEASE" });
    },
  };
  return {
    log,
    async query(sql, params) {
      log.push({ scope: "pool", sql: sql.trim(), params });
      if (/SELECT name FROM schema_migrations/.test(sql)) {
        return { rows: applied.map((name) => ({ name })) };
      }
      if (/information_schema\.tables/.test(sql)) {
        if (schemaExists === "partial") return { rows: [{ table_name: "document_chunks" }] };
        return { rows: schemaExists ? [{ table_name: "document_chunks" }, { table_name: "cgc_cve_report_runs" }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
}

async function tempMigrationsDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgc-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), sql);
  }
  return dir;
}

test("shipped migrations follow NNN_snake_case.sql and include the one-active-import index", async () => {
  const files = await listMigrationFiles(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  assert.equal(files[0], "001_pgvector_documents.sql");
  assert.ok(files.includes("005_one_active_import.sql"));
  assert.deepEqual(files, [...files].sort());
});

test("applies only pending files, in order, each in its own transaction, and records them", async () => {
  const dir = await tempMigrationsDir({
    "002_second.sql": "CREATE TABLE b (id int);",
    "001_first.sql": "CREATE TABLE a (id int);",
    "003_third.sql": "CREATE TABLE c (id int);",
  });
  const pool = fakePool({ applied: ["001_first.sql"] });
  const messages = [];
  const result = await runMigrations({ pool, dir, log: (message) => messages.push(message) });

  assert.deepEqual(result, { applied: ["002_second.sql", "003_third.sql"], skipped: ["001_first.sql"] });
  const clientSql = pool.log.filter((entry) => entry.scope === "client").map((entry) => entry.sql);
  assert.deepEqual(clientSql, [
    "SELECT pg_advisory_lock($1)", // blokada sesyjna runnera na dedykowanym kliencie, przez cały przebieg
    "BEGIN",
    "SET LOCAL lock_timeout = '10s'", // DDL na bazie dzielonej z www: lepiej paść niż kolejkować zapytania strony
    "CREATE TABLE b (id int);",
    "INSERT INTO schema_migrations (name) VALUES ($1)",
    "COMMIT",
    "RELEASE",
    "BEGIN",
    "SET LOCAL lock_timeout = '10s'",
    "CREATE TABLE c (id int);",
    "INSERT INTO schema_migrations (name) VALUES ($1)",
    "COMMIT",
    "RELEASE",
    "SELECT pg_advisory_unlock($1)",
    "RELEASE",
  ]);
  assert.match(pool.log.find((entry) => entry.scope === "pool").sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.deepEqual(messages, ["applied 002_second.sql", "applied 003_third.sql"]);
});

test("a failing migration rolls back, releases the client and stops the run", async () => {
  const dir = await tempMigrationsDir({ "001_bad.sql": "BROKEN SQL;", "002_never.sql": "SELECT 1;" });
  const pool = fakePool();
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const client = await originalConnect();
    return {
      ...client,
      async query(sql, params) {
        if (/BROKEN/.test(sql)) throw new Error("syntax error");
        return client.query(sql, params);
      },
    };
  };
  await assert.rejects(runMigrations({ pool, dir, log() {} }), /Migration 001_bad\.sql failed: syntax error/);
  const clientSql = pool.log.filter((entry) => entry.scope === "client").map((entry) => entry.sql);
  // blokada zwalniana także po błędzie (finally) — inaczej kolejny Job czekałby na koniec sesji
  assert.deepEqual(clientSql, ["SELECT pg_advisory_lock($1)", "BEGIN", "SET LOCAL lock_timeout = '10s'", "ROLLBACK", "RELEASE", "SELECT pg_advisory_unlock($1)", "RELEASE"]);
});

test("--baseline marks pending files as applied without executing them; --dry-run executes nothing", async () => {
  const dir = await tempMigrationsDir({ "001_first.sql": "CREATE TABLE a (id int);" });
  const baselinePool = fakePool();
  const baseline = await runMigrations({ pool: baselinePool, dir, baseline: true, log() {} });
  assert.deepEqual(baseline.applied, ["001_first.sql"]);
  assert.ok(baselinePool.log.some((entry) => /VALUES \(\$1, true\)/.test(entry.sql) && entry.params[0] === "001_first.sql"));
  assert.ok(!baselinePool.log.some((entry) => /CREATE TABLE a/.test(entry.sql)));

  const dryPool = fakePool();
  const messages = [];
  await runMigrations({ pool: dryPool, dir, dryRun: true, log: (message) => messages.push(message) });
  assert.deepEqual(messages, ["[dry-run] apply 001_first.sql"]);
  assert.ok(!dryPool.log.some((entry) => entry.scope === "client"));
});

test("rejects migration files that do not follow the naming convention", async () => {
  const dir = await tempMigrationsDir({ "fix.sql": "SELECT 1;" });
  await assert.rejects(listMigrationFiles(dir), /must match NNN_snake_case\.sql: fix\.sql/);
});


// --- poprawki po zimnym przeglądzie (paczka B) ---
test("auto-baseline: empty schema_migrations on an existing database marks ALL shipped files without executing them", async () => {
  const dir = await tempMigrationsDir({
    "001_pgvector_documents.sql": "ALTER TABLE would_fail;",
    "002_legacy.sql": "ALTER TABLE would_fail_too;",
    "003_example_table.sql": "CREATE TABLE IF NOT EXISTS example_table (x int);",
  });
  const pool = fakePool({ schemaExists: true });
  const messages = [];
  const result = await runMigrations({ pool, dir, log: (message) => messages.push(message) });

  // wszystko tylko oznaczone (baseline=true), nic niewykonane na wywodzącej się z rękodzieła bazie
  const baselined = pool.log.filter((entry) => /VALUES \(\$1, true\)/.test(entry.sql)).map((entry) => entry.params[0]);
  assert.deepEqual(baselined, ["001_pgvector_documents.sql", "002_legacy.sql", "003_example_table.sql"]);
  assert.ok(!pool.log.some((entry) => /would_fail/.test(entry.sql)), "no migration SQL executed");
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ["001_pgvector_documents.sql", "002_legacy.sql", "003_example_table.sql"]);
  assert.ok(messages.some((message) => /auto-baseline/.test(message)));

  // świeża baza (schemat nie istnieje): wszystko wykonywane normalnie
  const fresh = fakePool({ schemaExists: false });
  const freshResult = await runMigrations({ pool: fresh, dir, log() {} });
  assert.equal(freshResult.applied.length, 3);
  assert.ok(!fresh.log.some((entry) => /VALUES \(\$1, true\)/.test(entry.sql)));
});


test("auto-baseline dry-run predicts the real run (no double-reporting)", async () => {
  const dir = await tempMigrationsDir({
    "001_pgvector_documents.sql": "ALTER TABLE would_fail;",
    "002_legacy.sql": "ALTER TABLE would_fail_too;",
    "003_example_table.sql": "CREATE TABLE IF NOT EXISTS example_table (x int);",
  });
  const pool = fakePool({ schemaExists: true });
  const messages = [];
  const result = await runMigrations({ pool, dir, dryRun: true, log: (message) => messages.push(message) });
  // baseline'owane pliki NIE liczą się drugi raz jako "apply" — wszystko jest skipped
  assert.deepEqual(result.applied, []);
  assert.equal(messages.filter((m) => /\[dry-run\] baseline/.test(m)).length, 3);
  assert.deepEqual(messages.filter((m) => /\[dry-run\] apply/.test(m)), []);
  assert.ok(!pool.log.some((entry) => entry.scope === "client"), "dry-run executes nothing");
});
