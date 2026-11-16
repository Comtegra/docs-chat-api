import assert from "node:assert/strict";
import test from "node:test";

import {
  clampInt,
  containsControlChars,
  escapeHtml,
  getClientIp,
  applyCorsHeaders,
  getAllowedOrigins,
  isOriginAllowed,
  applyTenantCorsHeaders,
  isOriginAllowedByPatterns,
  matchesOriginPattern,
} from "../lib/apiGuards.mjs";

test("escapeHtml neutralizes markup and quotes", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"
  );
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml("zwykły tekst"), "zwykły tekst");
});

test("containsControlChars catches header-injection attempts", () => {
  assert.equal(containsControlChars("Jan\r\nBcc: spam@evil.test"), true);
  assert.equal(containsControlChars("Jan Kowalski"), false);
});

test("clampInt bounds values and falls back on garbage", () => {
  assert.equal(clampInt(7, { min: 1, max: 50, fallback: 10 }), 7);
  assert.equal(clampInt(-3, { min: 1, max: 50, fallback: 10 }), 1);
  assert.equal(clampInt(9999, { min: 1, max: 50, fallback: 10 }), 50);
  assert.equal(clampInt("abc", { min: 1, max: 50, fallback: 10 }), 10);
  assert.equal(clampInt(undefined, { min: 1, max: 50, fallback: undefined }), undefined);
  assert.equal(clampInt(2.5, { min: 1, max: 50, fallback: 10 }), 10);
});

test("getClientIp: X-Real-IP domyślnie zaufany (CGC = zawsze za ingress); opt-out false = adres gniazda; XFF nigdy", () => {
  const req = { headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8, 10.0.0.1" }, socket: { remoteAddress: "10.1.2.3" } };
  // default (bez env) = trust — serwis na CGC zawsze siedzi za ingress-nginx
  assert.equal(getClientIp(req, {}), "203.0.113.7");
  assert.equal(getClientIp(req, { DOCS_CHAT_TRUST_PROXY_HEADERS: "true" }), "203.0.113.7");
  // świadomy opt-out (egzotyczne wystawienie bez proxy): adres gniazda
  assert.equal(getClientIp(req, { DOCS_CHAT_TRUST_PROXY_HEADERS: "false" }), "10.1.2.3");
  assert.equal(
    getClientIp({ headers: { "x-forwarded-for": "203.0.113.8" }, socket: { remoteAddress: "10.1.2.3" } }, { DOCS_CHAT_TRUST_PROXY_HEADERS: "true" }),
    "10.1.2.3"
  );
  assert.equal(getClientIp({ headers: {} }, {}), "unknown");
  // IPv6: bucket per /64
  assert.equal(getClientIp({ headers: { "x-real-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" } }, { DOCS_CHAT_TRUST_PROXY_HEADERS: "true" }), "2001:db8:1:2::/64");
  assert.equal(getClientIp({ headers: { "x-real-ip": "2001:db8::1" } }, { DOCS_CHAT_TRUST_PROXY_HEADERS: "true" }), "2001:db8:0:0::/64");
  assert.equal(getClientIp({ headers: { "x-real-ip": "::ffff:203.0.113.9" } }, { DOCS_CHAT_TRUST_PROXY_HEADERS: "true" }), "::ffff:203.0.113.9");
});

test("CORS: reads docs allowlist from env; empty without env (fail-closed, no product default)", () => {
  assert.deepEqual(getAllowedOrigins({}), []);
  assert.deepEqual(
    getAllowedOrigins({
      DOCS_CHAT_ALLOWED_ORIGINS:
        "https://docs.example.com, http://localhost:3000 ",
    }),
    ["https://docs.example.com", "http://localhost:3000"]
  );
});

test("CORS: applyCorsHeaders sets headers only for allowlisted origins and reports the decision", () => {
  const mk = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const env = { DOCS_CHAT_ALLOWED_ORIGINS: "https://docs.example.com" };
  const ok = mk();
  assert.equal(applyCorsHeaders({ headers: { origin: "https://docs.example.com" } }, ok, env), true);
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://docs.example.com");
  assert.equal(ok.headers["Vary"], "Origin");
  const foreign = mk();
  assert.equal(applyCorsHeaders({ headers: { origin: "https://evil.example" } }, foreign, env), false);
  assert.deepEqual(foreign.headers, {});
  const sameOrigin = mk();
  assert.equal(applyCorsHeaders({ headers: {} }, sameOrigin, env), false);
  assert.deepEqual(sameOrigin.headers, {});
  assert.equal(isOriginAllowed(undefined, env), false);
});

// --- CORS per tenant (wzorce) ---

test("tenant CORS: exact origins are case-insensitive, wildcard patterns need https and a real subdomain", () => {
  assert.equal(matchesOriginPattern("https://Pomoc.onprem.example", "https://pomoc.onprem.example"), true);
  assert.equal(matchesOriginPattern("https://pomoc.onprem.example/manual", "https://pomoc.onprem.example"), false);
  assert.equal(matchesOriginPattern("https://manual.onprem.example", "*.onprem.example"), true);
  assert.equal(matchesOriginPattern("https://other.example", "*.onprem.example"), false);
  assert.equal(matchesOriginPattern("http://manual.onprem.example", "*.onprem.example"), false);
  assert.equal(matchesOriginPattern("https://evil-other.example", "*.onprem.example"), false);
  assert.equal(matchesOriginPattern("https://x.onprem.example.evil.example", "*.onprem.example"), false);
  assert.equal(matchesOriginPattern("not a url", "*.onprem.example"), false);
  assert.equal(matchesOriginPattern("https://anything.example", "*"), true);
  assert.equal(isOriginAllowedByPatterns(undefined, ["*"]), false);
  assert.equal(isOriginAllowedByPatterns("https://a.example", ["https://b.example", "*.a.example"]), false);
});

test("tenant CORS: requests without Origin are not CORS requests (curl/Angular server tests pass through)", () => {
  const mk = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const patterns = ["https://pomoc.onprem.example", "*.onprem.example"];

  const noOrigin = mk();
  assert.deepEqual(applyTenantCorsHeaders({ headers: {} }, noOrigin, patterns), { isCorsRequest: false, allowed: true });
  assert.deepEqual(noOrigin.headers, {});

  const ok = mk();
  assert.deepEqual(
    applyTenantCorsHeaders({ headers: { origin: "https://tst.miasto.onprem.example" } }, ok, patterns),
    { isCorsRequest: true, allowed: true }
  );
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://tst.miasto.onprem.example");
  assert.equal(ok.headers["Vary"], "Origin");
  assert.equal(ok.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");

  const foreign = mk();
  assert.deepEqual(
    applyTenantCorsHeaders({ headers: { origin: "https://evil.example" } }, foreign, patterns),
    { isCorsRequest: true, allowed: false }
  );
  assert.deepEqual(foreign.headers, {});
});
