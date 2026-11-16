import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  attachAbort,
  endSse,
  sendSseError,
  startSse,
  writeSse,
} from "../lib/chat/sseWriter.mjs";
import { createSseRes, parseFrames } from "./helpers/sseMocks.mjs";

test("startSse sets the SSE headers incl. X-Accel-Buffering", () => {
  const res = createSseRes();
  startSse(res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
});

test("writeSse writes one `data:` line per frame and returns true", () => {
  const res = createSseRes();
  assert.equal(writeSse(res, { type: "content", content: "a" }), true);
  assert.equal(writeSse(res, { type: "done", traceId: "t" }), true);
  assert.deepEqual(parseFrames(res.chunks), [
    { type: "content", content: "a" },
    { type: "done", traceId: "t" },
  ]);
});

test("writeSse never writes after end() (write-after-end guard) and returns false", () => {
  const res = createSseRes();
  res.end();
  assert.equal(writeSse(res, { type: "content", content: "late" }), false);
  assert.deepEqual(res.chunks, []);
});

test("writeSse never writes after client disconnect (destroyed)", () => {
  const res = createSseRes();
  res.simulateClientDisconnect();
  assert.equal(writeSse(res, { type: "content", content: "late" }), false);
  assert.deepEqual(res.chunks, []);
});

test("endSse is idempotent", () => {
  const res = createSseRes();
  let closes = 0;
  res.on("close", () => closes++);
  endSse(res);
  endSse(res);
  assert.equal(res.writableEnded, true);
  assert.equal(closes, 1);
});

test("sendSseError writes an error frame (message optional) and ends the stream", () => {
  const res = createSseRes();
  assert.equal(sendSseError(res, "llm_error", "boom"), true);
  assert.deepEqual(parseFrames(res.chunks), [
    { type: "error", code: "llm_error", message: "boom" },
  ]);
  assert.equal(res.writableEnded, true);

  const res2 = createSseRes();
  sendSseError(res2, "rate_limited");
  assert.deepEqual(parseFrames(res2.chunks), [{ type: "error", code: "rate_limited" }]);
});

test("attachAbort aborts on client disconnect (close with writableEnded=false)", () => {
  const res = createSseRes();
  const controller = attachAbort(res);
  assert.equal(controller.signal.aborted, false);
  res.simulateClientDisconnect();
  assert.equal(controller.signal.aborted, true);
});

test("attachAbort does NOT abort on normal end() (close with writableEnded=true)", () => {
  const res = createSseRes();
  const controller = attachAbort(res);
  writeSse(res, { type: "done", traceId: "t" });
  res.end();
  assert.equal(controller.signal.aborted, false);
});

test("attachAbort aborts immediately when res is already destroyed at attach time", () => {
  const res = createSseRes();
  res.simulateClientDisconnect();
  const controller = attachAbort(res);
  assert.equal(controller.signal.aborted, true);
});

test("heartbeat: SSE comment every interval while the stream lives, nothing after end or disconnect", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const res = createSseRes();
    startSse(res, { heartbeatMs: 100 });
    mock.timers.tick(250);
    assert.deepEqual(res.chunks, [": ping\n\n", ": ping\n\n"]);
    // komentarze są niewidoczne dla parsera ramek (jak w prawdziwych klientach)
    writeSse(res, { type: "content", content: "x" });
    assert.deepEqual(parseFrames(res.chunks), [{ type: "content", content: "x" }]);
    endSse(res);
    mock.timers.tick(500);
    assert.equal(res.chunks.length, 3); // nic po end()

    const dropped = createSseRes();
    startSse(dropped, { heartbeatMs: 100 });
    dropped.simulateClientDisconnect();
    mock.timers.tick(500);
    assert.deepEqual(dropped.chunks, []); // nic po zerwaniu — i żadnego write-after-end

    const silent = createSseRes();
    startSse(silent, { heartbeatMs: 0 });
    mock.timers.tick(1000);
    assert.deepEqual(silent.chunks, []);
  } finally {
    mock.timers.reset();
  }
});
