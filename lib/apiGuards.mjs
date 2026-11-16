const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function containsControlChars(value) {
  return /[\r\n\0]/.test(String(value ?? ""));
}

export function clampInt(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {any} req
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function getClientIp(req, env = process.env) {
  // Za ingress-nginx (domyślne use-forwarded-headers=false) X-Real-IP ustawia INGRESS z $remote_addr,
  // a nagłówki od klienta są nadpisywane. Serwis na CGC ZAWSZE siedzi za ingress — dlatego
  // ufamy X-Real-IP domyślnie, a DOCS_CHAT_TRUST_PROXY_HEADERS=false to świadomy opt-out
  // dla egzotycznego wystawienia bez proxy (XFF niezaufany nigdy: klient podałby dowolny adres
  // i obszedł limiter/kwotę). Bez proxy (lokalnie, testy): adres gniazda — X-Real-IP nieobecny.
  if (env.DOCS_CHAT_TRUST_PROXY_HEADERS !== "false") {
    const realIp = req?.headers?.["x-real-ip"];
    if (typeof realIp === "string" && realIp.trim()) {
      return normalizeClientIp(realIp.trim());
    }
  }
  return normalizeClientIp(req?.socket?.remoteAddress || "unknown");
}

/**
 * IPv6 liczymy per /64 (klient ma zwykle cały /64 — rotacja adresów w prefiksie nie obchodzi
 * limitera); IPv4 i mapped IPv4 bez zmian.
 * @param {string} ip
 */
export function normalizeClientIp(ip) {
  if (!ip.includes(":") || ip.startsWith("::ffff:")) return ip;
  const groups = ip.replace(/^\[|\]$/g, "").split("::");
  const head = groups[0].split(":").filter(Boolean).slice(0, 4);
  while (head.length < 4) head.push("0");
  return `${head.join(":")}::/64`;
}

// --- CORS dla strony dokumentacji — ścieżka legacy handlera docs-chat bez tenanta
// (lib/docsChat/handler.mjs); serwis /api/v1 używa applyTenantCorsHeaders niżej.
// Uwaga: CORS nie chroni zapisu (blokuje tylko ODCZYT odpowiedzi w przeglądarce) — to
// nie jest mechanizm autoryzacji, tylko warunek działania klienta z innego originu.

// Bez `DOCS_CHAT_ALLOWED_ORIGINS` allowlista jest PUSTA (fail-closed) — produkt nie wozi
// żadnej domyślnej domeny Comtegra; wdrożenie ustawia jawnie (ścieżka legacy bez tenanta;
// serwis /api/v1 zawsze bierze origins z konfiguracji tenanta).
export function getAllowedOrigins(env = process.env) {
  const configured = env.DOCS_CHAT_ALLOWED_ORIGINS;
  if (!configured) {
    return [];
  }

  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin, env = process.env) {
  if (!origin) {
    return false;
  }

  return getAllowedOrigins(env).includes(origin);
}

/**
 * Ustawia nagłówki CORS, jeśli Origin jest na allowliście docs. Zwraca true/false;
 * co z tym zrobić (403 jak docs-chat, czy „200 bez nagłówków" jak feedback) decyduje handler.
 */
/**
 * @param {any} req
 * @param {any} res
 * @param {Record<string, string|undefined>} [env]
 */
export function applyCorsHeaders(req, res, env = process.env) {
  const origin = req?.headers?.origin;
  if (!isOriginAllowed(origin, env)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

// --- CORS per tenant (rejestr lib/tenants): dokładne originy, wzorce `*.domena.pl` albo `*`.
// Semantyka zgodna z przeglądarką: żądanie BEZ nagłówka Origin nie jest żądaniem CORS
// (curl, testy, integracje serwerowe) — przechodzi bez nagłówków. Nadal nie jest to
// autoryzacja: ochroną kosztów są limity per IP; dostęp do treści niepublicznej dokumentacji
// chroni token strony (`X-Site-Token`, lib/server/indexAuth.mjs) — stąd w Allow-Headers.

/**
 * @param {string} origin   np. "https://manual.onprem.example"
 * @param {string} pattern  "https://host", "*.domena.pl" (tylko https, dowolna głębokość subdomen) albo "*"
 */
export function matchesOriginPattern(origin, pattern) {
  if (pattern === "*") {
    return true;
  }
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1).toLowerCase(); // ".domena.pl"
    let host;
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:") {
        return false;
      }
      host = url.hostname.toLowerCase();
    } catch {
      return false;
    }
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return origin.toLowerCase() === pattern.toLowerCase();
}

/**
 * @param {unknown} origin
 * @param {string[]} patterns
 */
export function isOriginAllowedByPatterns(origin, patterns) {
  if (typeof origin !== "string" || !origin) {
    return false;
  }
  return patterns.some((pattern) => matchesOriginPattern(origin, pattern));
}

/**
 * Ocena CORS dla tenanta i ustawienie nagłówków, gdy origin pasuje.
 * @param {any} req
 * @param {any} res
 * @param {string[]} patterns  tenant.cors.origins
 * @returns {{ isCorsRequest: boolean, allowed: boolean }}
 *   `allowed=false` tylko dla żądania CORS z originem spoza listy → handler odpowiada 403.
 */
export function applyTenantCorsHeaders(req, res, patterns) {
  const origin = req?.headers?.origin;
  if (typeof origin !== "string" || !origin) {
    return { isCorsRequest: false, allowed: true };
  }
  if (!isOriginAllowedByPatterns(origin, patterns)) {
    return { isCorsRequest: true, allowed: false };
  }
  // echo konkretnego originu (nie "*"): odpowiedź nie jest cache'owalna między originami
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Site-Token");
  res.setHeader("Access-Control-Max-Age", "600");
  return { isCorsRequest: true, allowed: true };
}
