// Migracje przy starcie: pula migracji bez PG_STATEMENT_TIMEOUT_MS, przebieg, zamknięcie,
// przywrócenie env; błąd migracji propaguje się (startup failed), ale env i pula są sprzątane.
import assert from "node:assert/strict";
import test from "node:test";

import { runBootMigrations } from "../db/bootMigrate.mjs";

/** @param {Record<string, string|undefined>} env */
function harness(env, migrateImpl) {
  const calls = { closed: 0, envAtMigrate: undefined, logs: [] };
  const pool = { marker: "migration-pool" };
  const deps = {
    getPool: () => {
      return pool;
    },
    closePool: async () => {
      calls.closed += 1;
    },
    runMigrations: async (options) => {
      calls.envAtMigrate = { ...env };
      assert.equal(options.pool, pool);
      for (const line of ["applied 001_pgvector_documents.sql"]) options.log(line);
      return migrateImpl(options);
    },
  };
  const logger = { info: (msg, fields) => calls.logs.push({ msg, fields }) };
  return { env, deps, logger, calls };
}

test("boot: migrations run on a pool without statement timeout, pool closed, env restored", async () => {
  const env = { DATABASE_URL: "postgresql://x", PG_STATEMENT_TIMEOUT_MS: "15000" };
  const { calls, deps, logger } = harness(env, async () => ({ applied: ["001_a.sql"], skipped: ["002_b.sql"] }));

  const result = await runBootMigrations({ logger, env, deps });

  assert.deepEqual(result, { applied: ["001_a.sql"], skipped: ["002_b.sql"] });
  // pula migracji powstaje w oknie bez statement timeout (DDL bez limitu, jak CLI)
  assert.equal(calls.envAtMigrate.PG_STATEMENT_TIMEOUT_MS, undefined);
  assert.equal(calls.closed, 1);
  // env serwisu odtworzony przed startem puli apki
  assert.equal(env.PG_STATEMENT_TIMEOUT_MS, "15000");
  assert.ok(calls.logs.some((line) => line.msg === "migrate"));
  assert.ok(calls.logs.some((line) => line.msg === "migrations" && line.fields.applied === 1 && line.fields.already === 1));
});

test("boot: no PG_STATEMENT_TIMEOUT_MS in env stays absent after the run", async () => {
  const env = { DATABASE_URL: "postgresql://x" };
  const { calls, deps, logger } = harness(env, async () => ({ applied: [], skipped: [] }));

  await runBootMigrations({ logger, env, deps });

  assert.equal("PG_STATEMENT_TIMEOUT_MS" in env, false);
  assert.equal(calls.closed, 1);
});

test("boot: a failed migration propagates (startup failed) but cleans the pool and env", async () => {
  const env = { DATABASE_URL: "postgresql://x", PG_STATEMENT_TIMEOUT_MS: "15000" };
  const { calls, deps, logger } = harness(env, async () => {
    throw new Error("Migration 001_a.sql failed: boom");
  });

  await assert.rejects(runBootMigrations({ logger, env, deps }), /boom/);
  assert.equal(calls.closed, 1, "migration pool closed before the failure escapes");
  assert.equal(env.PG_STATEMENT_TIMEOUT_MS, "15000", "env restored even on failure");
});
