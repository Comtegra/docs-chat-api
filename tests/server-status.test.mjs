import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { buildTenantStatus, getHealth, getTenantIndexStatus } from "../lib/server/status.mjs";

const TENANT = {
  id: "tst",
  name: "Test Assistant",
  model: "gemma-4-26b-a4b",
  locales: ["pl"],
  collections: { pl: "tst-docs-pl" },
};

test("health is ok when the database answers and error (not throw) when it does not or times out", async () => {
  assert.deepEqual(await getHealth({ pool: { async query() { return { rows: [{ "?column?": 1 }] }; } }, tenantCount: 2 }), {
    status: "ok",
    checks: { database: "ok", tenants: 2 },
  });
  const down = await getHealth({ pool: { async query() { throw new Error("ECONNREFUSED"); } }, tenantCount: 2 });
  assert.equal(down.status, "error");
  assert.equal(down.checks.database, "error");
  assert.equal(down.error, "database check failed"); // szczegóły tylko w logu (trasa publiczna)
  const slow = await getHealth({ pool: { query: () => new Promise(() => {}) }, tenantCount: 1, timeoutMs: 10 });
  assert.equal(slow.status, "error");
  assert.equal(slow.error, "database check failed");
});

test("tenant index status queries the active import per locale collection (language upper-cased)", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{ id: "imp-1", commit_sha: "abc123", activated_at: new Date("2026-09-01T10:00:00Z"), total_documents: "210" }],
      };
    },
  };
  const status = await getTenantIndexStatus({ tenant: TENANT, pool });
  assert.deepEqual(status, [
    { locale: "pl", collection: "tst-docs-pl", importId: "imp-1", commitSha: "abc123", activatedAt: "2026-09-01T10:00:00.000Z", documents: 210, embeddingModel: null },
  ]);
  assert.match(calls[0].sql, /status = 'active'/);
  assert.deepEqual(calls[0].params, ["tst-docs-pl", "PL"]);
});

test("tenant status is public and secret-free; no active import → nulls and zero documents", async () => {
  const pool = { async query() { return { rows: [] }; } };
  const status = await buildTenantStatus({ tenant: TENANT, pool, observability: false });
  assert.deepEqual(status, {
    tenant: "tst",
    name: "Test Assistant",
    model: "gemma-4-26b-a4b",
    locales: ["pl"],
    observability: false,
    auth: { siteToken: false },
    index: [{ locale: "pl", collection: "tst-docs-pl", importId: null, commitSha: null, activatedAt: null, documents: 0, embeddingModel: null }],
  });
  assert.equal(JSON.stringify(status).includes("Key"), false);
});

test("health gates readiness on the schema: missing migrations (or no schema_migrations yet) → error, all applied → ok", async () => {
  const errorLog = mock.method(console, "error", () => {});
  try {
    const applied = { async query() { return { rows: [{ name: "001_a.sql" }, { name: "002_b.sql" }] }; } };
    assert.deepEqual(await getHealth({ pool: applied, tenantCount: 1, migrations: ["001_a.sql", "002_b.sql"] }), {
      status: "ok",
      checks: { database: "ok", schema: "ok", tenants: 1 },
    });

    const behind = await getHealth({ pool: applied, tenantCount: 1, migrations: ["001_a.sql", "002_b.sql", "003_c.sql"] });
    assert.equal(behind.status, "error");
    assert.deepEqual(behind.checks, { database: "ok", schema: "behind", tenants: 1 });
    assert.equal(behind.error, "schema behind: pending migrations");
    assert.match(String(errorLog.mock.calls.at(-1)?.arguments.join(" ")), /missing migrations: 003_c\.sql/);

    // baza sprzed pierwszego uruchomienia runnera: brak tabeli = schemat w tyle, nie awaria bazy
    const noRunnerYet = { async query() { throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: "42P01" }); } };
    const fresh = await getHealth({ pool: noRunnerYet, tenantCount: 1, migrations: ["001_a.sql"] });
    assert.deepEqual(fresh.checks, { database: "ok", schema: "behind", tenants: 1 });

    // inny błąd zapytania = awaria bazy (jak dotąd)
    const down = { async query() { throw new Error("ECONNREFUSED"); } };
    const dead = await getHealth({ pool: down, tenantCount: 1, migrations: ["001_a.sql"] });
    assert.deepEqual(dead.checks, { database: "error", tenants: 1 });
  } finally {
    errorLog.mock.restore();
  }
});
