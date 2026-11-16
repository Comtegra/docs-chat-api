// @ts-check
// Sekrety żądań porównywane po sha256 (w konfiguracji tylko skróty; lista = rotacja bez przerwy;
// porównanie stałoczasowe):
// - indeksowanie: `Authorization: Bearer <klucz>` (DOCS_CHAT_INDEX_KEYS albo baza — indexKeys.mjs) — klucz jest związany
//   z tenantem, więc nie może pisać do kolekcji innego tenanta;
// - token strony: nagłówek `X-Site-Token` (DOCS_CHAT_SITE_TOKENS) dla czatu i feedbacku
//   z `auth.requireSiteToken` — sekret wypiekany w build strony klienta (dokumentacja niepubliczna:
//   kto widzi stronę, ma czat). Nie jest to sekret per użytkownik: token wycieka razem ze stroną,
//   więc limity per IP i limity klucza LLM w proxy zostają.

import crypto from "node:crypto";

/** nazwa nagłówka z tokenem strony (małe litery — tak Node wystawia `req.headers`) */
export const SITE_TOKEN_HEADER = "x-site-token";

/**
 * @param {string} secret
 */
export function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** @deprecated nazwa z czasów, gdy jedynym sekretem był klucz indeksu — to samo, co hashSecret */
export const hashIndexKey = hashSecret;

/**
 * @param {any} req
 * @returns {string|null}
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    return null;
  }
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * @param {any} req
 * @returns {string|null}
 */
export function siteTokenFromRequest(req) {
  const header = req?.headers?.[SITE_TOKEN_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim();
  return token.length > 0 ? token : null;
}

/**
 * @param {string} secret
 * @param {string[]} acceptedHashes  sha256 hex (małe litery)
 */
function matchesAnyHash(secret, acceptedHashes) {
  const provided = Buffer.from(hashSecret(secret), "hex");
  return acceptedHashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
}

/**
 * @param {string|null} secret
 * @param {string[]} acceptedHashes
 * @returns {"ok"|"missing"|"invalid"|"disabled"}
 */
function authorize(secret, acceptedHashes) {
  if (!acceptedHashes || acceptedHashes.length === 0) {
    return "disabled";
  }
  if (!secret) {
    return "missing";
  }
  return matchesAnyHash(secret, acceptedHashes) ? "ok" : "invalid";
}

/**
 * @param {any} req
 * @param {string[]} acceptedHashes  sha256 hex (małe litery)
 * @returns {"ok"|"missing"|"invalid"|"disabled"}
 */
export function authorizeIndexRequest(req, acceptedHashes) {
  return authorize(bearerToken(req), acceptedHashes);
}

/**
 * Token strony z `X-Site-Token`. `disabled` = tenant wymaga tokena, ale nie ma żadnego hasha w env
 * (błąd konfiguracji → 503, nie „wpuszczam wszystkich").
 * @param {any} req
 * @param {string[]} acceptedHashes
 * @returns {"ok"|"missing"|"invalid"|"disabled"}
 */
export function authorizeSiteToken(req, acceptedHashes) {
  return authorize(siteTokenFromRequest(req), acceptedHashes);
}
