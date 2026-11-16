import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { assertVectorSize, closePool, getPool, poolConfigFromEnv, toVectorLiteral } from "../lib/postgres.mjs";

test("serializes numeric arrays as pgvector literals", () => {
  assert.equal(toVectorLiteral([0.1, -2, 3]), "[0.1,-2,3]");
});

test("rejects non-finite vector values", () => {
  assert.throws(() => toVectorLiteral([1, Number.NaN]), /finite number/);
});

test("validates embedding vector size", () => {
  assert.doesNotThrow(() => assertVectorSize([1, 2, 3], 3));
  assert.throws(() => assertVectorSize([1, 2], 3), /Expected embedding dimension 3/);
});

test("pool config: safe defaults, env overrides applied", () => {
  const base = poolConfigFromEnv({ DATABASE_URL: "postgres://u:p@h/db" });
  assert.equal(base.connectionTimeoutMillis, 5000);
  assert.equal("max" in base, false);
  assert.equal("statement_timeout" in base, false);

  const tuned = poolConfigFromEnv({
    DATABASE_URL: "postgres://u:p@h/db",
    PG_POOL_MAX: "4",
    PG_CONNECT_TIMEOUT_MS: "1500",
    PG_STATEMENT_TIMEOUT_MS: "15000",
  });
  assert.equal(tuned.max, 4);
  assert.equal(tuned.connectionTimeoutMillis, 1500);
  assert.equal(tuned.statement_timeout, 15000);
});

test("pool config: garbage values fail at configuration time, not at the first query", () => {
  assert.throws(() => poolConfigFromEnv({}), /DATABASE_URL is required/);
  assert.throws(
    () => poolConfigFromEnv({ DATABASE_URL: "postgres://u:p@h/db", PG_POOL_MAX: "ten" }),
    /PG_POOL_MAX must be a positive integer/
  );
  assert.throws(
    () => poolConfigFromEnv({ DATABASE_URL: "postgres://u:p@h/db", PG_STATEMENT_TIMEOUT_MS: "0" }),
    /PG_STATEMENT_TIMEOUT_MS must be a positive integer/
  );
});

test("pool has an error listener: an idle client dying must not crash the process", async () => {
  process.env.DATABASE_URL = "postgres://user:pass@127.0.0.1:1/db";
  const errorLog = mock.method(console, "error", () => {});
  try {
    const pool = getPool();
    assert.equal(pool.listenerCount("error"), 1);
    // dokładnie to robi pg-pool przy błędzie bezczynnego klienta (restart bazy, pg_terminate_backend)
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection due to administrator command")));
    assert.equal(errorLog.mock.callCount(), 1);
    assert.match(String(errorLog.mock.calls[0].arguments.join(" ")), /idle client error.*administrator command/);
  } finally {
    errorLog.mock.restore();
    await closePool();
  }
});
