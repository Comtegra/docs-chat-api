import assert from "node:assert/strict";
import test from "node:test";

import { addOverlap, chunkDocument, packUnits, slugifyHeading, splitTextUnits } from "../lib/vdb/chunk.mjs";

const section = (title, words) => `\n## ${title}\n\n${"słowo ".repeat(words).trim()}\n`;

test("short documents stay whole with H1 prepended and no chunk metadata (parity with the exporter)", () => {
  const [doc] = chunkDocument({ title: "Wprowadzenie", text: "Treść.", metadata: { route: "/manual/docs/wprowadzenie", locale: "PL" } });
  assert.deepEqual(doc, {
    title: "Wprowadzenie",
    text: "# Wprowadzenie\nTreść.",
    file_path: null,
    metadata: { route: "/manual/docs/wprowadzenie", locale: "PL", sourceTitle: "Wprowadzenie" },
  });
});

test("long documents split on ## boundaries, pack up to max, overlap with a blank line, anchors per chunk", () => {
  const text = section("Alfa", 120) + section("Beta", 120) + section("Gamma", 120);
  const docs = chunkDocument(
    { title: "Duży", text, metadata: { route: "/r" }, headings: [{ text: "Alfa", id: "alfa" }, { text: "Beta", id: "beta" }, { text: "Gamma", id: "gamma" }] },
    { maxChars: 900, overlapChars: 50 }
  );
  assert.ok(docs.length >= 3);
  assert.equal(docs[0].title, `Duży - part 1/${docs.length}`);
  assert.equal(docs[0].metadata.chunk_index, 0);
  assert.equal(docs[0].metadata.chunk_count, docs.length);
  assert.equal(docs[0].metadata.chunked, true);
  assert.equal(docs[0].metadata.source_title, "Duży");
  assert.equal(docs[0].metadata.anchor, undefined);
  assert.match(docs[0].text, /^# Duży\n/);
  for (const doc of docs) assert.ok(doc.text.length <= 900, `chunk ${doc.metadata.chunk_index} within max`);
  // overlap: chunk 2 starts with the tail of chunk 1, then a blank line
  const tail = docs[0].text.slice(-50);
  assert.ok(docs[1].text.startsWith(tail), "overlap prefix");
  assert.match(docs[1].text.slice(50), /^\n\n/);
  // anchors resolve to the first ## heading in the chunk
  const anchored = docs.filter((doc) => doc.metadata.anchor);
  assert.ok(anchored.length >= 1);
  assert.ok(anchored.every((doc) => ["alfa", "beta", "gamma"].includes(doc.metadata.anchor)));
});

test("unit splitting: sections, oversized blocks by blank lines, then hard split; packing greedy", () => {
  const units = splitTextUnits("intro\n## A\npara1\n\npara2", 1000);
  assert.deepEqual(units, ["intro", "\n## A\npara1\n\npara2"]);
  const big = splitTextUnits("x".repeat(25), 10);
  assert.deepEqual(big, ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  assert.deepEqual(packUnits(["aa", "bb", "cc"], 4), ["aabb", "cc"]);
  assert.deepEqual(addOverlap(["first chunk", "second"], 5, 100), ["first chunk", "chunk\n\nsecond"]);
  assert.deepEqual(addOverlap(["only"], 5, 100), ["only"]);
});


// --- poprawka po zimnym przeglądzie (paczka C): kotwica nie może pochodzić z ogona overlapu ---
test("a heading living only in the overlap tail does not become the next chunk's anchor", () => {
  const intro = "wstęp ".repeat(115).trim();               // ~690 znaków
  const text = `\n${intro}\n## Krótki\nkk\n## Dalej\n${"treść ".repeat(115).trim()}`;
  const docs = chunkDocument(
    { title: "Doc", text, metadata: { route: "/r" }, headings: [
      { text: "Krótki", id: "krotki" },
      { text: "Dalej", id: "dalej" },
    ] },
    { maxChars: 800, overlapChars: 120 }
  );
  assert.equal(docs.length, 2);
  // overlap chunka 2 zawiera pełną linię "## Krótki" z ogona chunka 1…
  assert.match(docs[1].text, /## Krótki/);
  // …ale kotwica wskazuje sekcję, którą chunk 2 faktycznie SIĘ ZACZYNA (przed overlapem)
  assert.equal(docs[1].metadata.anchor, "dalej");
});

test("a text that already starts with an H1 is not prefixed twice; file_path is kept", () => {
  const [doc] = chunkDocument({ title: "Tytuł", text: "# Tytuł\nTreść.", file_path: "docs/t.md", metadata: { sourceTitle: "Tytuł" } });
  assert.deepEqual(doc, { title: "Tytuł", text: "# Tytuł\nTreść.", file_path: "docs/t.md", metadata: { sourceTitle: "Tytuł" } });
});

test("chunks already split by the exporter (metadata.chunked) pass through untouched", () => {
  const legacy = { title: "X - part 1/2", text: "# X\nfragment", file_path: "docs/x.md", metadata: { chunked: true, chunk_index: 0, chunk_count: 2, source_title: "X" } };
  assert.deepEqual(chunkDocument(legacy, { maxChars: 5 }), [legacy]);
});

test("anchors fall back to Docusaurus-style slugs when the document carries no heading ids", () => {
  assert.equal(slugifyHeading("Zakładanie sprawy"), "zakładanie-sprawy");
  assert.equal(slugifyHeading("Krok 1: **Wybierz** `moduł`"), "krok-1-wybierz-moduł");
  assert.equal(slugifyHeading("Dowolny tekst {#custom-id}"), "custom-id");
  const text = `\n${"wstęp ".repeat(120).trim()}\n## Zakładanie sprawy\n${"treść ".repeat(120).trim()}`;
  const docs = chunkDocument({ title: "Doc", text, metadata: {} }, { maxChars: 800, overlapChars: 0 });
  assert.equal(docs.length, 2);
  assert.equal(docs[1].metadata.anchor, "zakładanie-sprawy");
});
