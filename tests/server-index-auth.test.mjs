import assert from "node:assert/strict";
import test from "node:test";

import { authorizeIndexRequest, authorizeSiteToken, bearerToken, hashIndexKey, hashSecret, siteTokenFromRequest } from "../lib/server/indexAuth.mjs";

test("bearerToken extracts the token or null", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerToken({ headers: { authorization: "Basic abc" } }), null);
  assert.equal(bearerToken({ headers: { authorization: "Bearer " } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});

test("authorizeIndexRequest compares sha256 of the token against the accepted list (rotation-friendly)", () => {
  const current = hashIndexKey("current-key");
  const previous = hashIndexKey("previous-key");
  assert.equal(authorizeIndexRequest({ headers: { authorization: "Bearer current-key" } }, [current, previous]), "ok");
  assert.equal(authorizeIndexRequest({ headers: { authorization: "Bearer previous-key" } }, [current, previous]), "ok");
  assert.equal(authorizeIndexRequest({ headers: { authorization: "Bearer wrong" } }, [current]), "invalid");
  assert.equal(authorizeIndexRequest({ headers: {} }, [current]), "missing");
  assert.equal(authorizeIndexRequest({ headers: { authorization: "Bearer current-key" } }, []), "disabled");
  // hash nigdy nie równa się kluczowi w postaci jawnej
  assert.notEqual(current, "current-key");
  assert.match(current, /^[a-f0-9]{64}$/);
});

test("siteTokenFromRequest reads X-Site-Token (trimmed, first value) or null", () => {
  assert.equal(siteTokenFromRequest({ headers: { "x-site-token": " abc " } }), "abc");
  assert.equal(siteTokenFromRequest({ headers: { "x-site-token": ["first", "second"] } }), "first");
  assert.equal(siteTokenFromRequest({ headers: { "x-site-token": "   " } }), null);
  assert.equal(siteTokenFromRequest({ headers: {} }), null);
});

test("authorizeSiteToken: same rotation-friendly sha256 list semantics as the index key; no hashes = disabled (never ok)", () => {
  const current = hashSecret("site-token-current");
  const previous = hashSecret("site-token-previous");
  assert.equal(hashIndexKey, hashSecret);
  assert.equal(authorizeSiteToken({ headers: { "x-site-token": "site-token-current" } }, [current, previous]), "ok");
  assert.equal(authorizeSiteToken({ headers: { "x-site-token": "site-token-previous" } }, [current, previous]), "ok");
  assert.equal(authorizeSiteToken({ headers: { "x-site-token": "wrong" } }, [current]), "invalid");
  assert.equal(authorizeSiteToken({ headers: {} }, [current]), "missing");
  assert.equal(authorizeSiteToken({ headers: { "x-site-token": "site-token-current" } }, []), "disabled");
  // token strony nie otwiera endpointów indeksu i odwrotnie — inne nagłówki, inne listy hashy
  assert.equal(authorizeIndexRequest({ headers: { "x-site-token": "site-token-current" } }, [current]), "missing");
});
