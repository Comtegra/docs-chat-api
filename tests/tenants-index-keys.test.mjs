// @ts-check
// indexKeys: klucz importu — env (rotacja) > baza (persist przez recreate) > wygenerowany
// przy pierwszym boocie (RAW pokazany RAZ w logu, sha256 do instance_settings).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveIndexKeyHashes } from "../lib/tenants/indexKeys.mjs";

/**
 * Fake pool: mapa odpowiedzi wg dopasowania SQL (pierwszy pasujący wzorzec wygrywa).
 * @param {{ select?: any[], insertReturning?: any[] }} behaviour
 */
function fakePool(behaviour = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO instance_settings/.test(sql)) {
        return { rows: behaviour.insertReturning === undefined ? [{ value: "x" }] : behaviour.insertReturning };
      }
      if (/SELECT value FROM instance_settings/.test(sql)) {
        return { rows: behaviour.select === undefined ? [] : behaviour.select };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  return { pool, calls };
}

function fakeLogger() {
  const infos = [];
  return {
    logger: { info: (msg, fields) => infos.push({ msg, fields: fields || {} }) },
    infos,
  };
}

const VALID_SHA = "a".repeat(64);

test("env override (rotacja): DOCS_CHAT_INDEX_KEYS wygrywa, baza odpytana nie zostaje", async () => {
  const { pool, calls } = fakePool({ select: [{ value: "b".repeat(64) }] });
  const { logger, infos } = fakeLogger();
  const result = await resolveIndexKeyHashes({
    env: { DOCS_CHAT_INDEX_KEYS: `${VALID_SHA} ,${"c".repeat(64)}` },
    pool,
    logger,
  });
  assert.deepEqual(result, { hashes: [VALID_SHA, "c".repeat(64)], source: "env" });
  assert.equal(calls.length, 0, "env wins without touching the db");
  assert.equal(infos.length, 0);
});

test("env z pustą wartością działa jak nieustawiony — spada do bazy", async () => {
  const { pool, calls } = fakePool({ select: [{ value: "b".repeat(64) }] });
  const result = await resolveIndexKeyHashes({ env: { DOCS_CHAT_INDEX_KEYS: "  " }, pool, logger: { info() {} } });
  assert.deepEqual(result, { hashes: ["b".repeat(64)], source: "db" });
  assert.ok(calls.some((call) => /SELECT value FROM instance_settings/.test(call.sql)));
});

test("baza: istniejący wiersz = ten sam klucz po restarcie/recreatecie, bez logowania RAW", async () => {
  const { pool } = fakePool({ select: [{ value: "d".repeat(64) }] });
  const { logger, infos } = fakeLogger();
  const result = await resolveIndexKeyHashes({ env: {}, pool, logger });
  assert.deepEqual(result, { hashes: ["d".repeat(64)], source: "db" });
  assert.equal(infos.length, 0, "RAW istnieje tylko przy generacji, nie przy odczycie");
});

test("baza z pustą wartością = fail-closed (nie cichy fallback)", async () => {
  const { pool } = fakePool({ select: [{ value: "" }] });
  await assert.rejects(
    () => resolveIndexKeyHashes({ env: {}, pool, logger: { info() {} } }),
    /instance_settings\.index_keys_sha is empty/
  );
});

test("generacja: brak env i bazy → RAW zalogowany RAZ, sha256 zapisane do bazy", async () => {
  const { pool, calls } = fakePool({ select: [], insertReturning: [{ value: "inserted" }] });
  const { logger, infos } = fakeLogger();
  const result = await resolveIndexKeyHashes({ env: {}, pool, logger });

  assert.equal(result.source, "generated");
  assert.equal(result.hashes.length, 1);
  const logged = infos.find((entry) => entry.msg === "index key generated");
  assert.ok(logged, "RAW jest logowany przy generacji");
  const raw = logged.fields.DOCS_CHAT_INDEX_KEY;
  assert.ok(typeof raw === "string" && raw.length >= 32);
  // kontrakt: to, co pokazane w logu, haszuje się dokładnie do tego, co siedzi w bazie
  assert.equal(createHash("sha256").update(raw).digest("hex"), result.hashes[0]);
  // insert z ON CONFLICT DO NOTHING — wyścig równoległych bootów nie zepsuje wartości
  const insert = calls.find((call) => /INSERT INTO instance_settings/.test(call.sql));
  assert.ok(insert && /ON CONFLICT \(key\) DO NOTHING/.test(insert.sql));
  assert.equal(infos.filter((entry) => entry.msg === "index key generated").length, 1, "dokładnie raz");
});

test("wyścig o wiersz przegrany (INSERT bez RETURNING) = odczyt wygranego SHA, bez RAW w logu", async () => {
  const { pool } = fakePool({ select: [], insertReturning: [] });
  // przegrany INSERT → drugi SELECT czyta wartość wygranego boota
  let selected = 0;
  const origQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/SELECT value FROM instance_settings/.test(sql)) {
      selected += 1;
      if (selected === 1) return { rows: [] }; // pierwszy SELECT (przed INSERT) — brak wiersza
      return { rows: [{ value: "e".repeat(64) }] }; // drugi SELECT (po przegranej walce)
    }
    return origQuery(sql, params);
  };
  const { logger, infos } = fakeLogger();
  const result = await resolveIndexKeyHashes({ env: {}, pool, logger });
  assert.deepEqual(result, { hashes: ["e".repeat(64)], source: "db" });
  assert.equal(infos.length, 0, "RAW przegranego bootu NIE jest logowany");
});

test("zły SHA w env = fail-closed z czytelnym komunikatem", async () => {
  const { pool } = fakePool();
  await assert.rejects(
    () => resolveIndexKeyHashes({ env: { DOCS_CHAT_INDEX_KEYS: "plaintext" }, pool, logger: { info() {} } }),
    /DOCS_CHAT_INDEX_KEYS must be comma-separated sha256 hex digests/
  );
});
