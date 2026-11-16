import assert from "node:assert/strict";
import test from "node:test";

import { createSseParser } from "../lib/chat/sse.mjs";

// Ramki wg kontraktu SSE v2 (lib/chat/sse.mjs typedef): parser jest agnostyczny co do
// zawartości — zwraca obiekt, dispatch po `type` robi konsument (hook/reducer).
test("parses multiple typed frames from a single chunk", () => {
  const parse = createSseParser();
  const events = parse(
    'data: {"type":"content","content":"Hello"}\ndata: {"type":"content","content":" world"}\n'
  );
  assert.deepEqual(events, [
    { type: "content", content: "Hello" },
    { type: "content", content: " world" },
  ]);
});

test("buffers an event split across two chunks", () => {
  const parse = createSseParser();
  assert.deepEqual(parse('data: {"type":"content","con'), []);
  assert.deepEqual(parse('tent":"Cześć"}\n'), [{ type: "content", content: "Cześć" }]);
});

test("ignores non-data lines and keep-alive noise", () => {
  const parse = createSseParser();
  const events = parse(':keep-alive\n\ndata: {"type":"content","content":"ok"}\n');
  assert.deepEqual(events, [{ type: "content", content: "ok" }]);
});

test("skips a malformed JSON line without dropping later events", () => {
  const parse = createSseParser();
  const events = parse('data: {broken\ndata: {"type":"content","content":"fine"}\n');
  assert.deepEqual(events, [{ type: "content", content: "fine" }]);
});

test("passes error and done frames through for the caller to dispatch on `type`", () => {
  const parse = createSseParser();
  const events = parse(
    'data: {"type":"error","code":"llm_error","message":"Failed"}\ndata: {"type":"done","traceId":"t-1"}\n'
  );
  assert.deepEqual(events, [
    { type: "error", code: "llm_error", message: "Failed" },
    { type: "done", traceId: "t-1" },
  ]);
});

test("does not emit the trailing line until newline arrives", () => {
  const parse = createSseParser();
  assert.deepEqual(parse('data: {"type":"content","content":"a"}'), []);
  assert.deepEqual(parse("\n"), [{ type: "content", content: "a" }]);
});

test("splits frames when the writer's blank separator line arrives mid-chunk (\\n\\n framing)", () => {
  const parse = createSseParser();
  const events = parse(
    'data: {"type":"step","id":"retrieve","status":"running"}\n\ndata: {"type":"sources","sources":[]}\n\n'
  );
  assert.deepEqual(events, [
    { type: "step", id: "retrieve", status: "running" },
    { type: "sources", sources: [] },
  ]);
});
