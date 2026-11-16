// @ts-check
// Klucz importu instancji: env override > baza (persist przez recreate compute) > wygenerowany
// przy pierwszym boocie (RAW pokazany RAZ w logu startu, sha256 zapisane do instance_settings).
// `cgc compute create` nie może zwrócić wartości z bootu (wraca zanim pod wstanie) — log
// startu (`cgc logs <name>`) jest kanałem odczytu. Restart/recreate NIE rotuje klucza (SHA
// w bazie); rotacja = DOCS_CHAT_INDEX_KEYS (sha256, env) + recreate. Kontrakt autoryzacji jak
// dotąd: importer przedkłada RAW (Bearer), serwis porównuje sha256(presented) z tymi hashami.

import { createHash, randomBytes } from "node:crypto";

import { parseSha256HexList } from "./registry.mjs";

/** Klucz w instance_settings pod którym siedzi lista sha256 klucza importu. */
export const INDEX_KEYS_SETTING = "index_keys_sha";

/**
 * @returns {{ raw: string, sha: string }}
 */
function generateIndexKeyPair() {
  const raw = randomBytes(32).toString("base64url");
  return { raw, sha: createHash("sha256").update(raw).digest("hex") };
}

/**
 * Rozwiązuje listę sha256 akceptowanych kluczy importu (kolejność: env > baza > generuj).
 * @param {{
 *   env: Record<string, string|undefined>,
 *   pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
 *   logger: { info: (msg: string, fields: Record<string, unknown>) => void },
 * }} input
 * @returns {Promise<{ hashes: string[], source: "env"|"db"|"generated" }>}
 * @throws {Error}  zła wartość w env albo w bazie (fail-closed — import pada, nie cichy fallback)
 */
export async function resolveIndexKeyHashes({ env, pool, logger }) {
  const fromEnv = parseSha256HexList("DOCS_CHAT_INDEX_KEYS", env.DOCS_CHAT_INDEX_KEYS);
  if (fromEnv.length > 0) {
    return { hashes: fromEnv, source: "env" };
  }

  const existing = await pool.query("SELECT value FROM instance_settings WHERE key = $1", [
    INDEX_KEYS_SETTING,
  ]);
  if (existing.rows.length > 0) {
    const hashes = parseSha256HexList(
      `instance_settings.${INDEX_KEYS_SETTING}`,
      existing.rows[0].value
    );
    if (hashes.length === 0) {
      throw new Error(
        `instance_settings.${INDEX_KEYS_SETTING} is empty — set DOCS_CHAT_INDEX_KEYS or delete the row to regenerate`
      );
    }
    return { hashes, source: "db" };
  }

  const { raw, sha } = generateIndexKeyPair();
  const inserted = await pool.query(
    "INSERT INTO instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING value",
    [INDEX_KEYS_SETTING, sha]
  );
  if (inserted.rows.length === 0) {
    // równoległy boot wygrał wyścig o wiersz — jego RAW jest w jego logu; czytamy wygrane SHA
    const winner = await pool.query("SELECT value FROM instance_settings WHERE key = $1", [
      INDEX_KEYS_SETTING,
    ]);
    const hashes = parseSha256HexList(
      `instance_settings.${INDEX_KEYS_SETTING}`,
      winner.rows[0]?.value
    );
    if (hashes.length === 0) {
      throw new Error(`instance_settings.${INDEX_KEYS_SETTING} lost the insert race and is empty`);
    }
    return { hashes, source: "db" };
  }

  // RAW pokazany raz, tu i tylko tu — potem istnieje wyłącznie sha256 w bazie.
  // Wklej do sekretów CI jako DOCS_CHAT_INDEX_KEY (import korpusu + PUT /api/v1/admin/prompt).
  logger.info("index key generated", {
    DOCS_CHAT_INDEX_KEY: raw,
    shown: "once — copy it now into your CI secrets; the instance stores only its sha256",
  });
  return { hashes: [sha], source: "generated" };
}
