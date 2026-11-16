import assert from "node:assert/strict";
import test from "node:test";

import {
  ImportStateError,
  getImport,
  abortImport,
  activateImport,
  appendImportChunks,
  createImport,
  listImports,
  pruneImports,
  validateImportDocuments,
} from "../lib/vdb/imports.mjs";

/**
 * Fake puli: `rows` per wzorzec SQL; rejestruje wszystkie zapytania (pool i klient transakcji).
 */
function fakePool(responders = []) {
  const calls = [];
  const respond = (rawSql, params) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    for (const [pattern, rows] of responders) {
      if (pattern.test(sql)) return { rows: typeof rows === "function" ? rows(params) : rows };
    }
    return { rows: [] };
  };
  const client = {
    async query(sql, params) {
      calls.push({ scope: "tx", sql: sql.replace(/\s+/g, " ").trim(), params });
      return respond(sql, params);
    },
    release() {},
  };
  return {
    calls,
    async query(sql, params) {
      calls.push({ scope: "pool", sql: sql.replace(/\s+/g, " ").trim(), params });
      return respond(sql, params);
    },
    async connect() {
      return client;
    },
  };
}

const IMP = "0b5e1a4e-9c1d-4a52-8f6e-3d2b1a0c9e8f";
/** odpowiedź na guardowany UPDATE aktywacji (RETURNING id) — bez niej activate uznaje, że stan się zmienił */
const ACTIVATED = [/status = 'active', activated_at = now\(\)/, [{ id: "imp-1" }]];
const IMP0 = "1c6f2b5f-0d2e-4b63-9a7f-4e3c2b1d0f9a";
const PENDING = { id: IMP, collection_name: "tst-docs-pl", language: "PL", status: "pending", total_documents: 0 };
const embed = async (inputs) => inputs.map(() => [0.1, 0.2, 0.3]);

test("validateImportDocuments normalizes documents and rejects empty/invalid input", () => {
  assert.deepEqual(validateImportDocuments([{ title: " T ", text: " x ", metadata: { route: "/a" } }]), [
    { title: "T", text: "x", file_path: null, metadata: { route: "/a" } },
  ]);
  assert.throws(() => validateImportDocuments([]), /non-empty array/);
  assert.throws(() => validateImportDocuments([{ title: "T" }]), /data\[0\]\.text is required/);
  assert.throws(() => validateImportDocuments(["x"]), /data\[0\] must be an object/);
});

test("createImport inserts a pending import with 0 documents and returns its id", async () => {
  const pool = fakePool([[/INSERT INTO document_imports/, [{ id: IMP }]]]);
  const created = await createImport({ collectionName: "tst-docs-pl", language: "pl", source: "crawl", commitSha: "abc" }, { pool });
  assert.deepEqual(created, { importId: IMP, collectionName: "tst-docs-pl", language: "PL" });
  assert.match(pool.calls[0].sql, /'pending', 0/);
  assert.deepEqual(pool.calls[0].params.slice(0, 4), ["tst-docs-pl", "PL", "crawl", "abc"]);
  assert.equal(typeof pool.calls[0].params[4], "string"); // stempel modelu embeddingów
});

test("appendImportChunks: pending only; embeds in batches, inserts inactive rows in one transaction, bumps the counter", async () => {
  const pool = fakePool([
    [/FROM document_imports WHERE id/, [PENDING]],
    [/UPDATE document_imports SET total_documents/, [{ total_documents: 2 }]],
  ]);
  const batches = [];
  const result = await appendImportChunks(
    { importId: IMP, documents: [{ title: "A", text: "a" }, { title: "B", text: "b" }] },
    { pool, createEmbeddings: async (inputs) => { batches.push(inputs); return embed(inputs); }, batchSize: 1 }
  );
  assert.deepEqual(result, { importId: IMP, inserted: 2, total: 2 });
  assert.deepEqual(batches, [["a"], ["b"]]);
  const tx = pool.calls.filter((call) => call.scope === "tx").map((call) => call.sql);
  assert.equal(tx[0], "BEGIN");
  assert.equal(tx[1], "SELECT pg_advisory_xact_lock(hashtext($1))"); // pod blokadą kolekcji (wyścig z activate)
  // batch: JEDEN wielowierszowy INSERT dla obu chunków (koniec round-tripu per wiersz)
  assert.equal(tx.filter((sql) => /INSERT INTO document_chunks/.test(sql)).length, 1);
  assert.ok(tx.every((sql) => !/is_active = true/.test(sql)), "chunks are inserted inactive");
  assert.equal(tx.at(-1), "COMMIT");
  const insert = pool.calls.find((call) => /INSERT INTO document_chunks/.test(call.sql));
  assert.match(insert.sql, /VALUES \(\$1,.*\$8::vector, false\), \(\$9,.*\$16::vector, false\)/);
  assert.equal(insert.params.length, 16);
  assert.equal(insert.params[1], "tst-docs-pl");
  assert.equal(insert.params[7], "[0.1,0.2,0.3]");
  assert.equal(insert.params[11], "B");

  const active = fakePool([[/FROM document_imports WHERE id/, [{ ...PENDING, status: "active" }]]]);
  await assert.rejects(
    appendImportChunks({ importId: IMP, documents: [{ title: "A", text: "a" }] }, { pool: active, createEmbeddings: embed }),
    (error) => error instanceof ImportStateError && error.status === 409
  );
  const missing = fakePool();
  await assert.rejects(
    appendImportChunks({ importId: "nope", documents: [{ title: "A", text: "a" }] }, { pool: missing, createEmbeddings: embed }),
    (error) => error instanceof ImportStateError && error.status === 404
  );
});

test("activateImport: atomic swap in one transaction, previous active archived, returns previousImportId", async () => {
  const pool = fakePool([
    [/FROM document_imports WHERE id/, [{ ...PENDING, total_documents: 200 }]],
    [/status = 'active' ORDER BY activated_at/, [{ id: IMP0, total_documents: 210 }]],
    ACTIVATED,
  ]);
  const result = await activateImport({ importId: IMP }, { pool });
  assert.deepEqual(result, { importId: IMP, status: "active", documents: 200, previousImportId: IMP0 });
  const tx = pool.calls.filter((call) => call.scope === "tx").map((call) => call.sql);
  assert.deepEqual(
    tx.map((sql) => sql.slice(0, 41)),
    [
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1)", // blokada kolekcji PRZED pierwszą zmianą
      "UPDATE document_chunks SET is_active = fa",
      "UPDATE document_imports SET status = 'arc",
      "UPDATE document_chunks SET is_active = tr",
      "UPDATE document_imports SET status = 'act",
      "COMMIT",
    ]
  );
  assert.deepEqual(pool.calls.find((call) => /pg_advisory_xact_lock/.test(call.sql)).params, ["tst-docs-pl/PL"]);
  // guard stanu pod blokadą: aktywuje tylko pending/archived
  assert.match(tx[5], /WHERE id = \$1 AND status IN \('pending', 'archived'\) RETURNING id/);
});

test("activateImport: state changed under the lock (concurrent abort/activate) → 409 and ROLLBACK, nothing activated", async () => {
  const pool = fakePool([
    [/FROM document_imports WHERE id/, [{ ...PENDING, total_documents: 200 }]],
    // brak ACTIVATED: guardowany UPDATE nie trafia w żaden wiersz
  ]);
  await assert.rejects(
    activateImport({ importId: IMP }, { pool }),
    (error) => error instanceof ImportStateError && /state changed during activation/.test(error.message)
  );
  const tx = pool.calls.filter((call) => call.scope === "tx").map((call) => call.sql);
  assert.equal(tx.at(-1), "ROLLBACK");
});

test("activateImport guard: refuses a pending import far smaller than the active one unless forced; archived = rollback", async () => {
  const small = fakePool([
    [/FROM document_imports WHERE id/, [{ ...PENDING, total_documents: 50 }]],
    [/status = 'active' ORDER BY activated_at/, [{ id: IMP0, total_documents: 210 }]],
  ]);
  await assert.rejects(activateImport({ importId: IMP }, { pool: small }), /below 70%.*without force/);
  assert.ok(!small.calls.some((call) => call.scope === "tx"), "no transaction when refused");

  const forced = fakePool([
    [/FROM document_imports WHERE id/, [{ ...PENDING, total_documents: 50 }]],
    [/status = 'active' ORDER BY activated_at/, [{ id: IMP0, total_documents: 210 }]],
    ACTIVATED,
  ]);
  assert.equal((await activateImport({ importId: IMP, force: true }, { pool: forced })).status, "active");

  const rollback = fakePool([
    [/FROM document_imports WHERE id/, [{ ...PENDING, status: "archived", total_documents: 5 }]],
    [/status = 'active' ORDER BY activated_at/, [{ id: IMP0, total_documents: 210 }]],
    ACTIVATED,
  ]);
  const rolled = await activateImport({ importId: IMP }, { pool: rollback });
  assert.equal(rolled.previousImportId, IMP0);

  const empty = fakePool([[/FROM document_imports WHERE id/, [{ ...PENDING, total_documents: 0 }]]]);
  await assert.rejects(activateImport({ importId: IMP }, { pool: empty }), /has no chunks/);
  const failed = fakePool([[/FROM document_imports WHERE id/, [{ ...PENDING, status: "failed" }]]]);
  await assert.rejects(activateImport({ importId: IMP }, { pool: failed }), /failed import cannot/);
});

test("abortImport only fails a pending import; listImports/pruneImports use the collection scope", async () => {
  const ok = fakePool([[/SET status = 'failed'/, [{ id: IMP }]]]);
  assert.deepEqual(await abortImport({ importId: IMP, reason: "crawl failed" }, { pool: ok }), { importId: IMP, status: "failed" });
  assert.equal(ok.calls[0].params[1], "crawl failed");

  const active = fakePool([[/FROM document_imports WHERE id/, [{ ...PENDING, status: "active" }]]]);
  await assert.rejects(abortImport({ importId: IMP }, { pool: active }), /only a pending import can be aborted/);

  const list = fakePool([[/ORDER BY created_at DESC/, [{ id: IMP, status: "active" }]]]);
  const rows = await listImports({ collectionName: "tst-docs-pl", language: "pl", limit: 500 }, { pool: list });
  assert.equal(rows.length, 1);
  assert.deepEqual(list.calls[0].params, ["tst-docs-pl", "PL", 50]);

  const prune = fakePool([
    [/Import expired without activation/, [{ id: "old-pending" }]],
    [/row_number\(\) OVER/, [{ id: "imp-a" }, { id: "imp-b" }]],
  ]);
  const pruned = await pruneImports({ collectionName: "tst-docs-pl", language: "pl", keepArchived: 3 }, { pool: prune });
  assert.deepEqual(pruned, { expiredPending: 1, deletedImports: 2 });
  const tx = prune.calls.filter((call) => call.scope === "tx").map((call) => call.sql);
  // CAŁE sprzątanie w jednej transakcji pod blokadą kolekcji: wybór „stale" i DELETE widzą ten sam
  // stan, rollback (activate archiwalnego) czeka na COMMIT zamiast wchodzić między nie
  assert.equal(tx[0], "BEGIN");
  assert.equal(tx[1], "SELECT pg_advisory_xact_lock(hashtext($1))");
  assert.ok(tx.some((sql) => /Import expired without activation/.test(sql)));
  assert.ok(tx.some((sql) => /row_number\(\) OVER/.test(sql)));
  assert.equal(tx.at(-1), "COMMIT");
  assert.ok(!prune.calls.some((call) => call.scope === "pool"), "no statement outside the transaction");
  // chunki kasowane TYLKO dla importów, które wciąż nie są aktywne (pas i szelki — ta sama transakcja)
  assert.ok(tx.some((sql) => /DELETE FROM document_chunks WHERE import_id IN \(\s*SELECT id FROM document_imports WHERE id = ANY\(\$1::uuid\[\]\) AND status <> 'active'/s.test(sql)));
  assert.ok(tx.some((sql) => /DELETE FROM document_imports .* status <> 'active'/.test(sql)));
});

test("getImport treats non-UUID ids as not found (404), never as a pg 22P02 error — including near-miss UUIDs", async () => {
  const pool = fakePool();
  for (const bad of ["undefined", "notauuid", "123", "", null,
    "00000000-0000-400-800-000000000000",      // grupy 3-znakowe (re-check: {3,4} przepuszczało)
    "00000000-0000-4000-8000-00000000000",     // za krótka ostatnia grupa
    "g0000000-0000-4000-8000-000000000000"]) { // znak spoza hex
    assert.equal(await getImport(bad, { pool }), null, String(bad));
  }
  assert.equal(pool.calls.length, 0, "database never queried for malformed ids");
  // poprawny UUID z białymi znakami: przycięty PRZED związaniem z zapytaniem
  await getImport("  0b5e1a4e-9c1d-4a52-8f6e-3d2b1a0c9e8f  ", { pool });
  assert.equal(pool.calls[0].params[0], "0b5e1a4e-9c1d-4a52-8f6e-3d2b1a0c9e8f");
});

test("createImport maps ONLY the one-pending unique violation (003) to 409; other 23505 propagate", async () => {
  const throwing = (constraint) => ({
    async query() {
      const error = new Error("duplicate key value violates unique constraint");
      error.code = "23505";
      if (constraint) error.constraint = constraint;
      throw error;
    },
    async connect() { throw new Error("not used"); },
  });
  for (const constraint of ["document_imports_one_pending_idx", undefined]) {
    await assert.rejects(
      createImport({ collectionName: "tst-docs-pl", language: "pl" }, { pool: throwing(constraint) }),
      (error) => error instanceof ImportStateError && error.status === 409 && /Another pending import/.test(error.message)
    );
  }
  await assert.rejects(
    createImport({ collectionName: "tst-docs-pl", language: "pl" }, { pool: throwing("some_other_unique_idx") }),
    (error) => !(error instanceof ImportStateError) && /duplicate key/.test(error.message)
  );
});

test("createImport expires a stale pending (>24h) on conflict and retries once", async () => {
  const calls = [];
  let insertCount = 0;
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/INSERT INTO document_imports/.test(sql)) {
        insertCount += 1;
        if (insertCount === 1) {
          const error = new Error("duplicate key");
          error.code = "23505";
          error.constraint = "document_imports_one_pending_idx";
          throw error;
        }
        return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
      }
      if (/UPDATE document_imports/.test(sql)) {
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      }
      return { rows: [] };
    },
  };

  const created = await createImport({ collectionName: "tst-docs-pl", language: "pl" }, { pool });

  assert.equal(created.importId, "22222222-2222-4222-8222-222222222222");
  assert.ok(calls.some((sql) => /interval '24 hours'/.test(sql)));
  assert.equal(insertCount, 2);
});

test("createImport 409 names the blocking importId when the pending import is fresh", async () => {
  const pool = {
    async query(sql) {
      if (/INSERT INTO document_imports/.test(sql)) {
        const error = new Error("duplicate key");
        error.code = "23505";
        error.constraint = "document_imports_one_pending_idx";
        throw error;
      }
      if (/UPDATE document_imports/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }] };
    },
  };

  await assert.rejects(
    () => createImport({ collectionName: "tst-docs-pl", language: "pl" }, { pool }),
    (error) => error instanceof ImportStateError && error.status === 409 && /33333333/.test(error.message)
  );
});

test("createImport stamps the embedding model on the import row", async () => {
  const previous = process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_MODEL;
  try {
    let capturedParams = null;
    const pool = {
      async query(sql, params) {
        if (/INSERT INTO document_imports/.test(sql)) {
          capturedParams = params;
          return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] };
        }
        return { rows: [] };
      },
    };
    await createImport({ collectionName: "tst-docs-pl", language: "pl" }, { pool });
    assert.equal(capturedParams[4], "qwen3-embedding-8b"); // default modelu = stempel
  } finally {
    if (previous !== undefined) process.env.EMBEDDING_MODEL = previous;
  }
});
