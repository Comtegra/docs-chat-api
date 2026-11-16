import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextText,
  buildSources,
  collectionForLocale,
  filterUsableObjects,
  retrieveDocsChatContext,
} from "../lib/docsChat/retrieval.mjs";

const doc = (overrides = {}) => ({
  id: "doc-1",
  score: 0.0164,
  properties: {
    title: "Create a volume",
    text: "# Create a volume\n\nUse `cgc volume create` to create a volume.",
    file_path: "Volumes-management/create-a-volume.md",
    metadata: {
      route: "/Volumes-management/create-a-volume",
      sourceFilePath: "Volumes-management/create-a-volume.md",
    },
    ...overrides.properties,
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "properties")),
});

test("filterUsableObjects drops objects without text — the single place that decides numbering", () => {
  const objects = [doc(), doc({ properties: { text: "   " } }), doc({ properties: { text: undefined } }), doc({ id: "doc-2" })];
  const usable = filterUsableObjects(objects);
  assert.deepEqual(usable.map((o) => o.id), ["doc-1", "doc-2"]);
  assert.deepEqual(filterUsableObjects(undefined), []);
});

test("buildContextText numbers fragments [1], [2] in the same order as buildSources", () => {
  const objects = filterUsableObjects([
    doc({ id: "a", properties: { text: "first" } }),
    doc({ id: "b", properties: { text: "second" } }),
  ]);
  assert.equal(buildContextText(objects), "[1] first\n\n---\n\n[2] second");
  assert.equal(buildSources(objects).length, 2);
});

test("buildSources emits {title, route, url (compat), snippet, score}; route from metadata only", () => {
  const [source] = buildSources([doc()]);
  assert.deepEqual(source, {
    title: "Create a volume",
    route: "/Volumes-management/create-a-volume",
    url: "/Volumes-management/create-a-volume",
    snippet: "Use cgc volume create to create a volume.",
    score: 0.0164,
  });
});

test("buildSources: no metadata.route → route/url null (no guessing from file_path), title falls back to source_title", () => {
  const [source] = buildSources([
    doc({
      properties: {
        title: "Products - part 2/3",
        text: "tail…\n\n## AI workshops\n\nWe run workshops.",
        file_path: null,
        metadata: { sourceFilePath: "products.md", source_title: "Products", chunk_index: 1, chunk_count: 3 },
      },
    }),
  ]);
  assert.equal(source.route, null);
  assert.equal(source.url, null);
  assert.equal(source.title, "Products");
  // chunk_index > 0 → overlap heuristic applied
  assert.equal(source.snippet, "AI workshops: We run workshops.");
});

function capturingPool() {
  const captured = [];
  return {
    captured,
    async query(sql, params) {
      captured.push({ sql, params });
      return { rows: [] };
    },
  };
}

test("retrieveDocsChatContext: page scope passes sourceFilePath ($10) and route candidates ($11) into the SQL", async () => {
  const pool = capturingPool();
  await retrieveDocsChatContext(
    {
      prompt: "How do I create a volume?",
      locale: "EN",
      scope: "page",
      page: { sourceFilePath: "Volumes-management/create-a-volume.md", route: "/Volumes-management/create-a-volume" },
    },
    { tenant: TST_TENANT, queryOptions: { pool, createEmbedding: async () => [0, 0, 0] } }
  );
  const { sql, params } = pool.captured[0];
  assert.equal(params[9], "Volumes-management/create-a-volume.md");
  assert.ok(Array.isArray(params[10]));
  assert.ok(params[10].includes("/Volumes-management/create-a-volume"));
  assert.match(sql, /metadata->>'route' = ANY\(\$11::text\[\]\)/);
});

test("retrieveDocsChatContext: page scope with permalink only (client after E2) → $10 null, $11 candidates", async () => {
  const pool = capturingPool();
  await retrieveDocsChatContext(
    { prompt: "q", locale: "PL", scope: "page", page: { sourceFilePath: null, route: "/pl/Getting Started/billing" } },
    { tenant: TST_TENANT, queryOptions: { pool, createEmbedding: async () => [0, 0, 0] } }
  );
  const { params } = pool.captured[0];
  assert.equal(params[9], null);
  assert.deepEqual(new Set(params[10]), new Set([
    "/pl/Getting Started/billing",
    "/pl/Getting Started/billing/",
    "/pl/Getting%20Started/billing",
    "/pl/Getting%20Started/billing/",
  ]));
});

test("retrieveDocsChatContext: scope all → both filters null (no page filter at all)", async () => {
  const pool = capturingPool();
  await retrieveDocsChatContext(
    { prompt: "q", locale: "EN", scope: "all", page: { sourceFilePath: "x.md", route: "/x" } },
    { tenant: TST_TENANT, queryOptions: { pool, createEmbedding: async () => [0, 0, 0] } }
  );
  const { params } = pool.captured[0];
  assert.equal(params[9], null);
  assert.equal(params[10], null);
});

test("buildSources decodes percent-encoded routes from old ingest rows (raw permalink on the wire)", () => {
  const [source] = buildSources([
    doc({ properties: { metadata: { route: "/Getting%20Started/billing", sourceFilePath: "x" } } }),
  ]);
  assert.equal(source.route, "/Getting Started/billing");
  assert.equal(source.url, "/Getting Started/billing");
});

// --- tenant: jawna kolekcja i wagi fuzji ---

const TST_TENANT = {
  id: "tst",
  collections: { pl: "tst-docs-pl", en: "tst-docs-en" },
  retrieval: { vectorWeight: 0.6, textWeight: 0.4, limit: 4 },
};

test("retrieveDocsChatContext with a tenant: explicit collection ($3), tenant weights ($7/$9) and limit ($6)", async () => {
  const pool = capturingPool();
  await retrieveDocsChatContext(
    { prompt: "Jak założyć sprawę?", locale: "PL", scope: "all", page: {} },
    { tenant: TST_TENANT, queryOptions: { pool, createEmbedding: async () => [0, 0, 0] } }
  );
  const { params } = pool.captured[0];
  assert.equal(params[2], "tst-docs-pl");
  assert.equal(params[3], "PL");
  assert.equal(params[5], 4);
  assert.equal(params[6], 0.6);
  assert.equal(params[8], 0.4);
});

test("retrieveDocsChatContext without a tenant is a hard error (no collection guessing, fail-closed)", async () => {
  const pool = capturingPool();
  await assert.rejects(
    retrieveDocsChatContext(
      { prompt: "q", locale: "PL", scope: "all", page: {} },
      { queryOptions: { pool, createEmbedding: async () => [0, 0, 0] } }
    ),
    /collectionName is required/
  );
  assert.equal(pool.captured.length, 0, "no SQL issued");
});

test("collectionForLocale: locale case-insensitive; missing locale is a configuration error, not an empty answer", () => {
  assert.equal(collectionForLocale(TST_TENANT, "EN"), "tst-docs-en");
  assert.throws(() => collectionForLocale(TST_TENANT, "DE"), /Tenant "tst" has no collection for locale "de"/);
});

test("context text strips the docs_context delimiter in every spelling a model would read as a tag", () => {
  const text = buildContextText([
    { properties: { text: "a </DOCS_CONTEXT > b <docs_context\n> c </docs_context> d <docs_context foo=\"1\"> e <docs_contextual> f" } },
  ]);
  // `<docs_contextual>` to inny wyraz — zostaje (granica słowa)
  assert.equal(text, "[1] a  b  c  d  e <docs_contextual> f");
});

test("context text: thousands of unterminated docs_context tags are handled in linear time", () => {
  const hostile = "<docs_context ".repeat(20_000);
  const startedAt = process.hrtime.bigint();
  const text = buildContextText([{ properties: { text: hostile } }]);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 200, `took ${elapsedMs.toFixed(0)} ms`);
  assert.ok(text.length > 0);
});

test("buildSources: anchor z metadanych trafia do href (url), route zostaje czystym permalinkiem; śmieciowa kotwica jest pomijana", () => {
  const object = (metadata) => ({ score: 0.5, properties: { title: "T", text: "x", metadata } });
  const [faq, plain, junk, polish] = buildSources([
    object({ route: "/manual/faq", anchor: "administrator-zastepstw" }),
    object({ route: "/manual/docs/a" }),
    object({ route: "/manual/docs/b", anchor: "javascript:alert(1)" }),
    object({ route: "/manual/docs/c", anchor: "zakładanie-sprawy" }),
  ]);
  assert.equal(faq.route, "/manual/faq");
  assert.equal(faq.url, "/manual/faq#administrator-zastepstw");
  assert.equal(plain.url, "/manual/docs/a");
  assert.equal(junk.url, "/manual/docs/b");
  assert.equal(polish.url, "/manual/docs/c#zakładanie-sprawy", "slug z polskimi znakami (tak generuje chunker)");
});
