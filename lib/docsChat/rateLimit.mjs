// @ts-check
import crypto from "node:crypto";

import { getPool } from "../postgres.mjs";

const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_WINDOW_SECONDS = 600;
const DEFAULT_SALT = "docs-chat-dev-salt";

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {string|undefined} clientIp
 * @param {string} [salt]
 */
export function hashRateLimitKey(clientIp, salt = DEFAULT_SALT) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${clientIp || "unknown"}`)
    .digest("hex");
}

/**
 * Licznik okna stałego per klucz (IP, ew. z prefiksem tenanta/endpointu). Limity: z `input`
 * (rejestr tenantów) albo z env DOCS_CHAT_RATE_LIMIT_* (ścieżka legacy). FAIL-CLOSED w
 * wywołujących endpointach zapisu/kosztu: wyjątek propaguje.
 * @param {{ clientIp: string, maxRequests?: number, windowSeconds?: number }} input
 * @param {{ env?: Record<string, string|undefined>, pool?: any }} [options]
 */
export async function checkDocsChatRateLimit(input, options = {}) {
  const env = options.env || process.env;
  const pool = options.pool || getPool();
  const maxRequests = positiveInteger(
    input?.maxRequests ?? env.DOCS_CHAT_RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_MAX_REQUESTS
  );
  const windowSeconds = positiveInteger(
    input?.windowSeconds ?? env.DOCS_CHAT_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_WINDOW_SECONDS
  );
  const keyHash = hashRateLimitKey(
    input?.clientIp,
    env.DOCS_CHAT_RATE_LIMIT_SALT || DEFAULT_SALT
  );

  // Retencja sprzątania NIEZALEŻNA od okna wywołania: tabela jest wspólna dla wielu bucketów
  // (chat per tenant, feedback, legacy vdb-query) o potencjalnie różnych oknach — kasowanie po
  // oknie bieżącego bucketa kasowałoby ŻYWE okna dłuższych (reset ich liczników). 24 h to więcej
  // niż każde sensowne okno; wiersze są malutkie.
  await pool.query(
    `
      DELETE FROM docs_chat_rate_limits
      WHERE ctid IN (
        SELECT ctid
        FROM docs_chat_rate_limits
        WHERE window_start < now() - interval '24 hours'
        LIMIT 1000
      )
    `
  );

  const upsertResult = await pool.query(
    `
      WITH current_window AS (
        SELECT to_timestamp(
          floor(extract(epoch from now()) / $2::int) * $2::int
        ) AS window_start
      )
      INSERT INTO docs_chat_rate_limits (
        key_hash,
        window_start,
        request_count
      )
      SELECT $1, window_start, 1
      FROM current_window
      ON CONFLICT (key_hash, window_start)
      DO UPDATE
      SET request_count = docs_chat_rate_limits.request_count + 1,
          updated_at = now()
      WHERE docs_chat_rate_limits.request_count < $3::int
      RETURNING request_count
    `,
    [keyHash, windowSeconds, maxRequests]
  );

  if (upsertResult.rows.length === 0) {
    return {
      allowed: false,
      remaining: 0,
      limit: maxRequests,
      windowSeconds,
    };
  }

  const requestCount = Number(upsertResult.rows[0]?.request_count || 0);

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - requestCount),
    limit: maxRequests,
    windowSeconds,
  };
}
