import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRouteCandidates,
  encodeRouteSegments,
  buildDocumentObjects,
  buildTextSearchQuery,
  getHybridQuerySql,
  queryDocuments,
} from "../lib/vdb/documents.mjs";

test("queryDocuments requires an explicit collectionName (no branded defaults)", async () => {
  await assert.rejects(
    queryDocuments({ query: "q", language: "EN" }, { pool: { async query() { return { rows: [] }; } }, createEmbedding: async () => [0] }),
    /collectionName is required/
  );
});

test("builds Weaviate-compatible document objects for the chat UI", () => {
  const objects = buildDocumentObjects([
    {
      id: "chunk-1",
      title: "LLM inference API",
      text: "Docs text",
      file_path: "llm-api.md",
      metadata: { section: "api" },
      score: 0.82,
    },
  ]);

  assert.deepEqual(objects, [
    {
      id: "chunk-1",
      properties: {
        title: "LLM inference API",
        text: "Docs text",
        file_path: "llm-api.md",
        metadata: { section: "api" },
      },
      score: 0.82,
    },
  ]);
});

test("uses halfvec casts for 3584-dimension indexed vector search", () => {
  const sql = getHybridQuerySql(3584);

  assert.match(sql, /embedding::halfvec\(3584\) <=> \$1::halfvec\(3584\)/);
  assert.doesNotMatch(sql, /ORDER BY embedding <=> \$1::vector/);
});

test("builds focused full-text query terms for team questions", () => {
  assert.equal(buildTextSearchQuery("Who is in the team?"), "team");
  assert.equal(buildTextSearchQuery("Kto jest w zespole?"), "zespole");
  assert.equal(buildTextSearchQuery("Who works in the CGC team?"), "works | cgc | team");
});

test("uses focused full-text terms when querying documents", async () => {
  const capturedQueries = [];
  const pool = {
    async query(sql, params) {
      capturedQueries.push({ sql, params });
      return { rows: [] };
    },
  };

  await queryDocuments(
    { query: "Who is in the team?", language: "EN", collectionName: "docs-en" },
    {
      pool,
      createEmbedding: async () => [0, 0, 0],
    }
  );

  assert.equal(capturedQueries.length, 1);
  assert.equal(capturedQueries[0].params[1], "team");
});

test("can constrain document retrieval to a Docusaurus source file path", async () => {
  const capturedQueries = [];
  const pool = {
    async query(sql, params) {
      capturedQueries.push({ sql, params });
      return { rows: [] };
    },
  };

  await queryDocuments(
    {
      query: "How do I create a volume?",
      language: "EN",
      collectionName: "docs-en",
      sourceFilePath: "Volumes-management/create-a-volume.md",
    },
    {
      pool,
      createEmbedding: async () => [0, 0, 0],
    }
  );

  assert.equal(capturedQueries.length, 1);
  assert.match(
    capturedQueries[0].sql,
    /metadata->>'sourceFilePath' = \$10/
  );
  assert.match(capturedQueries[0].sql, /file_path = \$10/);
  assert.equal(
    capturedQueries[0].params[9],
    "Volumes-management/create-a-volume.md"
  );
});

test("buildRouteCandidates covers raw/decoded/encoded × with/without trailing slash, deduped; null when absent", () => {
  assert.equal(buildRouteCandidates(null), null);
  assert.equal(buildRouteCandidates("   "), null);
  assert.deepEqual(buildRouteCandidates("/"), ["/"]);
  assert.deepEqual(buildRouteCandidates("//"), ["/"]);
  assert.deepEqual(buildRouteCandidates("/a//"), ["/a", "/a/"]);
  // malformed percent sequences: decoding falls back to the raw value (extra harmless variants)
  assert.ok(buildRouteCandidates("/a%E0%A4%A").includes("/a%E0%A4%A"));
  assert.deepEqual(new Set(buildRouteCandidates("/Changelog/")), new Set(["/Changelog", "/Changelog/"]));
  assert.deepEqual(
    new Set(buildRouteCandidates("/Running Jobs/compute")),
    new Set([
      "/Running Jobs/compute",
      "/Running Jobs/compute/",
      "/Running%20Jobs/compute",
      "/Running%20Jobs/compute/",
    ])
  );
  // already-encoded input decodes to the same set
  assert.deepEqual(
    new Set(buildRouteCandidates("/Running%20Jobs/compute")),
    new Set(buildRouteCandidates("/Running Jobs/compute"))
  );
});

test("encodeRouteSegments mirrors python urllib.parse.quote(part) — encodes space and !'()* , keeps /", () => {
  assert.equal(encodeRouteSegments("/Getting Started/billing"), "/Getting%20Started/billing");
  assert.equal(encodeRouteSegments("/a(b)!'*"), "/a%28b%29%21%27%2A");
  assert.equal(encodeRouteSegments("/pl/x_y-z.md"), "/pl/x_y-z.md");
});

test("page scope by route only: $10 null, $11 = candidates, predicate guards against silently matching everything", async () => {
  const capturedQueries = [];
  const pool = {
    async query(sql, params) {
      capturedQueries.push({ sql, params });
      return { rows: [] };
    },
  };
  await queryDocuments(
    { query: "How do I create a volume?", language: "EN", collectionName: "docs-en", route: "/Volumes-management/create-a-volume" },
    { pool, createEmbedding: async () => [0, 0, 0] }
  );
  const { sql, params } = capturedQueries[0];
  assert.equal(params[9], null);
  assert.ok(params[10].includes("/Volumes-management/create-a-volume"));
  assert.match(sql, /\(\$10::text IS NULL AND \$11::text\[\] IS NULL\)/);
  assert.match(sql, /metadata->>'route' = ANY\(\$11::text\[\]\)/);
  // three occurrences: vector candidates, text candidates, final select
  assert.equal(sql.match(/metadata->>'route' = ANY/g).length, 3);
});

test("no page filter at all: both $10 and $11 are null", async () => {
  const capturedQueries = [];
  const pool = {
    async query(sql, params) {
      capturedQueries.push({ sql, params });
      return { rows: [] };
    },
  };
  await queryDocuments({ query: "q", language: "EN", collectionName: "docs-en" }, { pool, createEmbedding: async () => [0, 0, 0] });
  assert.equal(capturedQueries[0].params[9], null);
  assert.equal(capturedQueries[0].params[10], null);
  assert.equal(capturedQueries[0].params.length, 11);
});
