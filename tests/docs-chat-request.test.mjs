import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeClientId,
  normalizeLocale,
  normalizePageRoute,
  normalizeDocusaurusSource,
  validateDocsChatRequest,
} from "../lib/docsChat/request.mjs";

test("validates the public docs chat request contract", () => {
  const request = validateDocsChatRequest({
    prompt: "How do I create a volume?",
    locale: "pl",
    scope: "page",
    page: {
      source: "@site/i18n/pl/docusaurus-plugin-content-docs/current/Volumes-management/create-a-volume.md",
      permalink: "/pl/Volumes-management/create-a-volume",
      title: "Create a volume",
    },
  });

  assert.equal(request.prompt, "How do I create a volume?");
  assert.equal(request.locale, "PL");
  assert.equal(request.scope, "page");
  assert.equal(
    request.page.sourceFilePath,
    "Volumes-management/create-a-volume.md"
  );
  assert.equal(request.page.route, "/pl/Volumes-management/create-a-volume");
});

test("rejects invalid docs chat requests before retrieval or LLM work", () => {
  assert.throws(
    () => validateDocsChatRequest({ prompt: "", locale: "en", scope: "all" }),
    /prompt is required/
  );

  assert.throws(
    () =>
      validateDocsChatRequest({
        prompt: "x".repeat(2001),
        locale: "en",
        scope: "all",
      }),
    /prompt must be at most 2000 characters/
  );

  assert.throws(
    () =>
      validateDocsChatRequest({
        prompt: "How?",
        locale: "de",
        scope: "all",
      }),
    /locale must be en or pl/
  );

  assert.throws(
    () =>
      validateDocsChatRequest({
        prompt: "How?",
        locale: "en",
        scope: "category",
      }),
    /scope must be page or all/
  );
});

test("normalizes Docusaurus source aliases into import metadata paths", () => {
  assert.equal(
    normalizeDocusaurusSource("@site/docs/Getting Started/installation.mdx"),
    "Getting Started/installation.mdx"
  );

  assert.equal(
    normalizeDocusaurusSource(
      "@site/i18n/pl/docusaurus-plugin-content-docs/current/intro.md"
    ),
    "intro.md"
  );
});

test("page scope accepts permalink only (client after E2) and keeps route; rejects when both are missing", () => {
  const request = validateDocsChatRequest({
    prompt: "q",
    locale: "pl",
    scope: "page",
    page: { permalink: "/pl/Getting Started/billing" },
  });
  assert.equal(request.page.sourceFilePath, null);
  assert.equal(request.page.route, "/pl/Getting Started/billing");

  assert.throws(
    () => validateDocsChatRequest({ prompt: "q", locale: "en", scope: "page", page: {} }),
    /page\.permalink or page\.source is required/
  );
});

test("normalizePageRoute: leading slash, no control chars (spaces are legal Docusaurus permalinks), ≤ 512 chars", () => {
  assert.equal(normalizePageRoute("/Changelog/"), "/Changelog/");
  assert.equal(normalizePageRoute("  /x  "), "/x");
  assert.equal(normalizePageRoute("/Getting Started/billing"), "/Getting Started/billing");
  assert.equal(normalizePageRoute("relative"), null);
  assert.equal(normalizePageRoute("/has\nnewline"), null);
  assert.equal(normalizePageRoute("/has\ttab"), null);
  assert.equal(normalizePageRoute("/" + "a".repeat(512)), null);
  assert.equal(normalizePageRoute("/" + "a".repeat(511)), "/" + "a".repeat(511));
  assert.equal(normalizePageRoute(42), null);
});

// --- tenant: polityka locale i id wdrożenia ---

test("locale policy: tenant default and allowed list; legacy stays en|pl with en default", () => {
  assert.equal(normalizeLocale(undefined), "EN");
  assert.equal(normalizeLocale("PL"), "PL");
  assert.throws(() => normalizeLocale("de"), /locale must be en or pl/);

  const plOnly = { defaultLocale: "pl", allowedLocales: ["pl"] };
  assert.equal(normalizeLocale(undefined, plOnly), "PL");
  assert.equal(normalizeLocale(" pl ", plOnly), "PL");
  assert.throws(() => normalizeLocale("en", plOnly), /locale must be pl/);
  assert.throws(() => normalizeLocale("../x", { defaultLocale: "pl", allowedLocales: ["pl", "../x"] }), /locale must be/);

  const request = validateDocsChatRequest({ prompt: "q", scope: "all" }, plOnly);
  assert.equal(request.locale, "PL");
});

test("client id: base64url-owy token ≤64 znaków; reszta (w tym HTML/CRLF/=) staje się null, nigdy błędem", () => {
  assert.equal(normalizeClientId("dXJ6YWQtMQ"), "dXJ6YWQtMQ");
  assert.equal(normalizeClientId("  abc-123  "), "abc-123");
  assert.equal(normalizeClientId("dXJ6YWQtMQ=="), null); // '=' poza zbiorem — id ląduje w Langfuse/raportach
  assert.equal(normalizeClientId("<script>"), null);
  assert.equal(normalizeClientId("zł"), null);
  assert.equal(normalizeClientId("a".repeat(65)), null);
  assert.equal(normalizeClientId(undefined), null);
});
