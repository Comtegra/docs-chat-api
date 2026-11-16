import assert from "node:assert/strict";
import test from "node:test";

import { toSnippet } from "../lib/vdb/snippet.mjs";

// Fixture'y = kształt chunków z cgc-user-docs/python/md_to_json.py:
// "# <tytuł>\n" + surowy MDX (frontmatter i komentarze zdjęte).

test("drops the leading H1 (title duplicate) and returns plain text", () => {
  const text = "# Create a volume\n\nUse `cgc volume create` to create a volume.\n";
  assert.equal(toSnippet(text), "Use cgc volume create to create a volume.");
});

test("strips MDX imports, JSX tags, admonitions, links, images and emphasis", () => {
  const text = [
    "# LLM inference API",
    "",
    "import Tabs from '@theme/Tabs';",
    "import TabItem from '@theme/TabItem';",
    "",
    ":::tip Ważne",
    "Base URL: [llm.comtegra.cloud](https://llm.comtegra.cloud/v1) — **OpenAI-compatible**.",
    ":::",
    "",
    "<Tabs>",
    "<TabItem value=\"py\" label=\"Python\">",
    "Klucz w nagłówku *Authorization*. ![diagram](/img/x.png)",
    "</TabItem>",
    "</Tabs>",
  ].join("\n");
  assert.equal(
    toSnippet(text),
    "Base URL: llm.comtegra.cloud — OpenAI-compatible. Klucz w nagłówku Authorization. diagram"
  );
});

test("removes fenced code blocks entirely (both ``` and ~~~), keeps surrounding prose", () => {
  const text =
    "# vLLM\n\nStart the server:\n\n```bash\ncgc compute create vllm -g 2\n```\n\nThen call it.\n\n~~~\nraw block\n~~~\nDone.";
  assert.equal(toSnippet(text), "Start the server: Then call it. Done.");
});

test("handles an unterminated fence at the end of a chunk (cut by chunking)", () => {
  const text = "# X\n\nIntro sentence.\n\n```json\n{\"a\": 1,\n  \"b\": 2";
  assert.equal(toSnippet(text), "Intro sentence.");
});

test("flattens tables and lists into text", () => {
  const text =
    "# GPUs\n\n| GPU | VRAM |\n| --- | --- |\n| A100 | 80 GB |\n| H100 | 80 GB |\n\n- first item\n- second item\n1. numbered\n> quoted";
  assert.equal(toSnippet(text), "GPU VRAM A100 80 GB H100 80 GB first item second item numbered quoted");
});

test("truncates at a sentence boundary when one exists late enough, else at a word with an ellipsis", () => {
  const sentences = "# T\n\n" + "First sentence is here. Second sentence follows it. Third sentence closes.";
  const cut = toSnippet(sentences, 60);
  assert.equal(cut, "First sentence is here. Second sentence follows it.");

  const words = "# T\n\n" + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const cutWords = toSnippet(words, 30);
  assert.ok(cutWords.endsWith("…"), cutWords);
  assert.ok(cutWords.length <= 31, cutWords);
  assert.doesNotMatch(cutWords, /\s…$/);
});

test("chunkIndex > 0: skips the overlap tail when a heading starts inside the first 300 chars", () => {
  const overlapTail = "…and this is the tail of the previous section that got copied as overlap text";
  const text = `${overlapTail}\n\n## Billing\n\nYou pay per GPU-hour.\n\nMore text.`;
  assert.equal(toSnippet(text, 240, { chunkIndex: 1 }), "Billing: You pay per GPU-hour. More text.");
});

test("chunkIndex > 0 without a heading in the overlap window: starts at the first sentence end", () => {
  const text = "tail of previous chunk continues here. New sentence of this chunk.";
  assert.equal(toSnippet(text, 240, { chunkIndex: 2 }), "New sentence of this chunk.");
  // no sentence end either → text unchanged
  assert.equal(toSnippet("no punctuation at all here", 240, { chunkIndex: 2 }), "no punctuation at all here");
});

test("chunkIndex 0 / undefined never applies the overlap heuristic", () => {
  const text = "# Title\n\nintro line\n\n## Section\n\nbody";
  assert.equal(toSnippet(text, 240, { chunkIndex: 0 }), "intro line Section: body");
  assert.equal(toSnippet(text), "intro line Section: body");
});

test("returns an empty string for empty / non-string / markup-only input", () => {
  assert.equal(toSnippet(""), "");
  assert.equal(toSnippet(null), "");
  assert.equal(toSnippet(undefined), "");
  assert.equal(toSnippet("# Only a title\n"), "");
  assert.equal(toSnippet("# T\n\n```\ncode only\n```\n"), "");
});

test("never leaks fence markers, tags or import lines even when they are the whole snippet window", () => {
  const text = "# T\n\nimport X from 'y';\n<Tabs>\n:::note\n```js\nconst a = 1;\n```\n:::\n</Tabs>\nEnd.";
  const out = toSnippet(text);
  assert.equal(out, "End.");
  assert.doesNotMatch(out, /```|<|>|import /);
});

// --- kształty z PRAWDZIWEGO chunkera (md_to_json add_overlap): stary ingest sklejał ogon
// poprzedniego chunka z nagłówkiem BEZ separatora; nowy rozdziela pustą linią.

test("old-ingest overlap: '…end.## Heading' glued without newline is un-glued and skipped", () => {
  const glued = "or client access (required) SFU_AUTH_USER value.## Configuration\n\nSet the env vars.";
  assert.equal(toSnippet(glued, 240, { chunkIndex: 1 }), "Configuration: Set the env vars.");
});

test("old-ingest overlap ending with a fence: '…\\n```## Heading' — the bare ``` closes the previous chunk's fence, nothing is swallowed", () => {
  const glued = "print(x)\n```## Usage\n\nCall the endpoint with your key.\n\n```bash\ncgc x\n```\n\nDone.";
  assert.equal(toSnippet(glued, 240, { chunkIndex: 1 }), "Usage: Call the endpoint with your key. Done.");
});

test("old-ingest overlap: tail is a code block without heading afterwards — cut at the fence closer", () => {
  const glued = "  return 1\n```\n\nAfter the code we continue the story.";
  assert.equal(toSnippet(glued, 240, { chunkIndex: 3 }), "After the code we continue the story.");
});

test("new-ingest overlap ('tail\\n\\n## Heading') keeps working", () => {
  const text = "…tail of the previous section\n\n## Billing\n\nYou pay per GPU-hour.";
  assert.equal(toSnippet(text, 240, { chunkIndex: 1 }), "Billing: You pay per GPU-hour.");
});

test("headings get ': ' so they don't run into the paragraph; ## leaks never appear", () => {
  const text = "# T\n\n## Overview\n\nThe text2vec API embeds text.\n\n### Auth\nUse a key.";
  const out = toSnippet(text);
  assert.equal(out, "Overview: The text2vec API embeds text. Auth: Use a key.");
  assert.doesNotMatch(out, /#/);
});

test("CLI placeholders inside inline code survive; prose comparisons survive; only real tags are stripped", () => {
  const text =
    "# T\n\nRun `cgc volume delete <volume_name>` or `--api-key <APP_TOKEN>`. If x < 5 and y > 3, retry. <Tabs><TabItem value=\"a\">inside</TabItem></Tabs> <video src=\"x.mp4\" /> end";
  assert.equal(
    toSnippet(text),
    "Run cgc volume delete <volume_name> or --api-key <APP_TOKEN>. If x < 5 and y > 3, retry. inside end"
  );
});

test("reference-style link definitions and MDX module lines are removed, prose starting with 'export' stays", () => {
  const text = "# T\n\n[1]: https://example.com\nimport Tabs from '@theme/Tabs';\nexport const x = 1;\nexport the model before deploying.";
  assert.equal(toSnippet(text), "export the model before deploying.");
});

test("input is capped (pathological 32k input stays fast and bounded)", () => {
  const t0 = performance.now();
  const out = toSnippet("`".repeat(32000) + " tail");
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `took ${ms} ms`);
  assert.equal(typeof out, "string");
});
