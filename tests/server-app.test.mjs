// Integracja serwisu docs-chat-api na prawdziwym node:http (port efemeryczny): routing, CORS,
// limity body, SSE end-to-end przez adapter — z zamockowanymi zależnościami handlera.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { homeTenant, syntheticTenant } from "./helpers/tenants.mjs";
import { createDocsChatApp } from "../lib/server/app.mjs";
import { hashIndexKey } from "../lib/server/indexAuth.mjs";
import { createLogger } from "../lib/server/logging.mjs";
import { createTenantRegistry } from "../lib/tenants/registry.mjs";
import { tenantConfigFromEnv } from "../lib/tenants/envConfig.mjs";

const DOC = {
  id: "doc-1",
  score: 0.5,
  properties: {
    title: "Zakładanie sprawy",
    text: "Sprawę zakładasz w module Kwestie.",
    file_path: null,
    metadata: { route: "/manual/getting-started/zakladanie-sprawy" },
  },
};

// tenant tst wymaga tokena strony (auth.requireSiteToken): harness konfiguruje jeden hash, a żądania
// do /tst/chat|feedback niosą nagłówek — bez niego serwis odpowiada 401 (test niżej)
const SITE_TOKEN = "tst-site-token-test";
const SITE_TOKEN_ENV = { DOCS_CHAT_SITE_TOKENS: hashIndexKey(SITE_TOKEN) };

async function startServer({ pool, handlerOverrides = {}, services, migrations, env = SITE_TOKEN_ENV, tenants = [syntheticTenant] } = {}) {
  const logLines = [];
  const registry = createTenantRegistry({
    tenants: tenants.map((make) => make(env)),
    env,
    warn() {},
  });
  const app = createDocsChatApp({
    registry,
    env,
    pool: pool || { async query() { return { rows: [] }; } },
    migrations,
    logger: createLogger({ write: (line) => logLines.push(JSON.parse(line)) }),
    services: services || (() => ({ langfuseService: { enabled: false, createTrace: () => null, async finalizeTrace() {} }, llmClient: {} })),
    handlerOverrides: {
      checkRateLimit: async () => ({ allowed: true }),
      retrieveContext: async () => [DOC],
      streamCompletion: async function* () {
        yield { type: "content", content: "Sprawę zakładasz w module Kwestie [1]." };
      },
      ...handlerOverrides,
    },
  });
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    logLines,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block && !block.startsWith(":")) // komentarze SSE (heartbeat) jak w prawdziwym parserze
    .map((line) => JSON.parse(line.replace(/^data: /, "")));
}

test("health: 200 with database ok, 503 when the database is down; no-store", async () => {
  const ok = await startServer();
  try {
    const response = await fetch(`${ok.base}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "ok", checks: { database: "ok", tenants: 1 } });
  } finally {
    await ok.close();
  }
  const down = await startServer({ pool: { async query() { throw new Error("db down"); } } });
  try {
    const response = await fetch(`${down.base}/api/v1/health`);
    assert.equal(response.status, 503);
  } finally {
    await down.close();
  }
});

test("routing: unknown path 404 (also the legacy /{tenant} shape), wrong method 405 with Allow, nothing outside /api/v1", async () => {
  const server = await startServer();
  try {
    const unknownPath = await fetch(`${server.base}/api/v1/nope/status`);
    assert.equal(unknownPath.status, 404);
    assert.deepEqual(await unknownPath.json(), { error: "Not found" });

    // stary kształt ścieżki z segmentem tenanta nie istnieje — częsty błąd po aktualizacji klienta
    const legacyShape = await fetch(`${server.base}/api/v1/tst/chat`);
    assert.equal(legacyShape.status, 404);

    const wrongMethod = await fetch(`${server.base}/api/v1/chat`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST, OPTIONS");

    for (const path of ["/", "/api/docs-chat/completion", "/admin", "/api/vdb/query"]) {
      const response = await fetch(`${server.base}${path}`);
      assert.equal(response.status, 404, path);
    }
    assert.ok(server.logLines.every((line) => line.service === "docs-chat-api" && typeof line.durationMs === "number"));
    assert.ok(server.logLines.every((line) => !("ip" in line)));
  } finally {
    await server.close();
  }
});

test("chat: SSE end-to-end through the node:http adapter with tenant CORS", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "x-site-token": SITE_TOKEN, "content-type": "application/json", origin: "https://tst.miasto.onprem.example" },
      body: JSON.stringify({ prompt: "Jak założyć sprawę?", scope: "all", client: "r-1" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://tst.miasto.onprem.example");
    const frames = await readSse(response);
    assert.equal(frames[0].type, "step");
    assert.equal(frames.find((frame) => frame.type === "sources").sources[0].title, "Zakładanie sprawy");
    assert.deepEqual(frames.find((frame) => frame.type === "step" && frame.id === "answer" && frame.status === "running").meta, {
      model: "gemma-4-26b-a4b",
    });
    assert.deepEqual(frames.at(-1), { type: "done", traceId: null });

    const chatLog = server.logLines.find((line) => line.path === "/api/v1/chat");
    assert.equal(chatLog.tenant, "tst");
    assert.equal(chatLog.status, 200);
  } finally {
    await server.close();
  }
});

test("chat: invalid JSON 400, oversized body 413, preflight 204; foreign origin is 403 on an explicit origin list", async () => {
  const server = await startServer();
  try {
    const badJson = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "x-site-token": SITE_TOKEN, "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(badJson.status, 400);

    const huge = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "x-site-token": SITE_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(70 * 1024), scope: "all" }),
    });
    assert.equal(huge.status, 413);

    const preflight = await fetch(`${server.base}/api/v1/chat`, {
      method: "OPTIONS",
      headers: { origin: "https://docs.tst.example", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://docs.tst.example");
  } finally {
    await server.close();
  }

  // tenant z jawną listą originów: cudzy origin odrzucony przed handlerem
  const home = await startServer({ tenants: [homeTenant] });
  try {
    const foreign = await fetch(`${home.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ prompt: "q", scope: "all" }),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await home.close();
  }
});

test("status: public status with CORS; a differently-named deployment answers with its own identity", async () => {
  const pool = {
    async query(sql, params) {
      if (/document_imports/.test(sql)) {
        return { rows: [{ id: "imp-9", commit_sha: "f505ec9", activated_at: new Date("2026-09-01T08:00:00Z"), total_documents: 210, embeddingModel: null }] };
      }
      return { rows: [] };
    },
  };
  const server = await startServer({ pool });
  try {
    const response = await fetch(`${server.base}/api/v1/status`, { headers: { origin: "https://docs.tst.example" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://docs.tst.example");
    const status = await response.json();
    assert.equal(status.tenant, "tst");
    assert.equal(status.name, "Test Assistant");
    assert.equal(status.observability, false);
    assert.deepEqual(status.index[0], {
      locale: "pl",
      collection: "tst-docs-pl",
      importId: "imp-9",
      commitSha: "f505ec9",
      activatedAt: "2026-09-01T08:00:00.000Z",
      documents: 210,
      embeddingModel: null,
    });

    const cgc = await startServer({ tenants: [homeTenant], pool });
    try {
      const response = await fetch(`${cgc.base}/api/v1/status`);
      assert.equal((await response.json()).tenant, "cgc");
    } finally {
      await cgc.close();
    }
  } finally {
    await server.close();
  }
});

test("feedback: tenant CORS, Langfuse score, 202 when observability is off", async () => {
  const scores = [];
  const server = await startServer({
    services: () => ({
      llmClient: {},
      langfuseService: { enabled: true, createTrace: () => null, async finalizeTrace() {}, score: (input) => { scores.push(input); return true; }, async flushAsync() {} },
    }),
  });
  try {
    const traceId = "8af13fd5-0d36-40ef-9659-4574e3181e36";
    const stored = await fetch(`${server.base}/api/v1/feedback`, {
      method: "POST",
      headers: { "x-site-token": SITE_TOKEN, "content-type": "application/json", origin: "https://docs.tst.example" },
      body: JSON.stringify({ traceId, value: 1 }),
    });
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), { stored: true });
    assert.equal(stored.headers.get("access-control-allow-origin"), "https://docs.tst.example");
    assert.equal(scores[0].traceId, traceId);
  } finally {
    await server.close();
  }

  const off = await startServer({ tenants: [homeTenant] });
  try {
    const notStored = await fetch(`${off.base}/api/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "8af13fd5-0d36-40ef-9659-4574e3181e36", value: -1 }),
    });
    assert.equal(notStored.status, 202);
  } finally {
    await off.close();
  }
});

test("site token: chat/feedback need X-Site-Token (401 with CORS headers, before body and limiter); preflight advertises the header", async () => {
  let limiterCalls = 0;
  const server = await startServer({ handlerOverrides: { checkRateLimit: async () => { limiterCalls += 1; return { allowed: true }; } } });
  try {
    const missing = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://docs.tst.example" },
      body: JSON.stringify({ prompt: "Jak założyć sprawę?", scope: "all" }),
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "Site token required" });
    // przeglądarka na dozwolonym originie musi zobaczyć 401 (komunikat w widgecie), nie błąd sieci
    assert.equal(missing.headers.get("access-control-allow-origin"), "https://docs.tst.example");

    const wrong = await fetch(`${server.base}/api/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-site-token": "nope" },
      body: JSON.stringify({ traceId: "8af13fd5-0d36-40ef-9659-4574e3181e36", value: 1 }),
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "Invalid site token" });
    assert.equal(limiterCalls, 0, "odrzut tokena nie dotyka limitera (bazy)");

    // tst domyślnie przyjmuje każdy origin (`*`): on-premy pod IP/.local; token strony pilnuje treści
    const anyOrigin = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://10.101.20.100:4438", "x-site-token": SITE_TOKEN },
      body: JSON.stringify({ prompt: "Jak założyć sprawę?", scope: "all" }),
    });
    assert.equal(anyOrigin.status, 200);
    assert.equal(anyOrigin.headers.get("access-control-allow-origin"), "https://10.101.20.100:4438");
    assert.equal((await readSse(anyOrigin)).at(-1).type, "done");

    const preflight = await fetch(`${server.base}/api/v1/chat`, {
      method: "OPTIONS",
      headers: { origin: "https://docs.tst.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-site-token" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /X-Site-Token/);

    const status = await (await fetch(`${server.base}/api/v1/status`)).json();
    assert.deepEqual(status.auth, { siteToken: true });
    assert.equal(JSON.stringify(status).includes(SITE_TOKEN), false);
  } finally {
    await server.close();
  }

  // wdrożenie publiczne (bez auth.requireSiteToken): czat bez tokena, jak dotąd
  const home = await startServer({ tenants: [homeTenant] });
  try {
    const cgc = await fetch(`${home.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "How do I create a volume?", scope: "all" }),
    });
    assert.equal(cgc.status, 200);
    assert.equal((await readSse(cgc)).at(-1).type, "done");
  } finally {
    await home.close();
  }
});

test("site token: with a restricted origin list (TENANT_TST_EXTRA_ORIGINS) a foreign origin is 403 before the token is checked", async () => {
  const server = await startServer({ env: { ...SITE_TOKEN_ENV, TENANT_TST_EXTRA_ORIGINS: "https://docs.tst.example" } });
  try {
    const foreign = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", "x-site-token": SITE_TOKEN },
      body: JSON.stringify({ prompt: "q", scope: "all" }),
    });
    assert.equal(foreign.status, 403); // nie zdradzamy, czy token był dobry
  } finally {
    await server.close();
  }
});

test("site token: tenant requiring a token but without hashes in env answers 503 (fail-closed), never lets traffic through", async () => {
  const server = await startServer({ env: {} });
  try {
    const response = await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-site-token": SITE_TOKEN },
      body: JSON.stringify({ prompt: "q", scope: "all" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Site token is not configured for this tenant" });
  } finally {
    await server.close();
  }
});

// --- indeksowanie: Bearer klucz tenanta, cykl create → chunks → activate, własność importu ---

function importsPool({ gateImportInsert = null } = {}) {
  const state = { imports: new Map(), chunks: [], queries: [] };
  let counter = 0;
  const client = {
    async query(rawSql, params) {
      const sql = rawSql.replace(/\s+/g, " ").trim();
      if (/INSERT INTO document_chunks/.test(sql)) {
        // INSERT wielowierszowy: 8 parametrów na wiersz (import_id … embedding)
        for (let index = 0; index < params.length; index += 8) {
          state.chunks.push({ importId: params[index], title: params[index + 3] });
        }
        return { rows: [] };
      }
      if (/SET total_documents = total_documents \+/.test(sql)) {
        const row = state.imports.get(params[0]);
        row.total_documents += params[1];
        return { rows: [{ total_documents: row.total_documents }] };
      }
      if (/SET status = 'active'/.test(sql)) {
        // guard jak w SQL: aktywacja tylko pending/archived, RETURNING id
        const row = state.imports.get(params[0]);
        if (!row || !["pending", "archived"].includes(row.status)) return { rows: [] };
        row.status = "active";
        return { rows: [{ id: row.id }] };
      }
      // prune (w transakcji): stan do asercji zbierany także z klienta
      state.queries.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  return {
    state,
    async query(rawSql, params) {
      const sql = rawSql.replace(/\s+/g, " ").trim();
      state.queries.push(sql);
      if (/INSERT INTO document_imports/.test(sql)) {
        if (gateImportInsert) await gateImportInsert();
        counter += 1;
        // id musi być UUID — getImport odrzuca inne formaty zanim zapyta bazę (404)
        const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
        state.imports.set(id, { id, collection_name: params[0], language: params[1], status: "pending", total_documents: 0, commit_sha: params[3], source: params[2] });
        return { rows: [{ id }] };
      }
      if (/FROM document_imports WHERE id/.test(sql)) {
        const row = state.imports.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/SET status = 'failed'/.test(sql)) {
        const row = state.imports.get(params[0]);
        if (!row || row.status !== "pending") return { rows: [] };
        row.status = "failed";
        row.error = params[1];
        return { rows: [{ id: row.id }] };
      }
      if (/status = 'active' ORDER BY activated_at/.test(sql)) {
        return { rows: [...state.imports.values()].filter((row) => row.status === "active" && row.collection_name === params[0]) };
      }
      if (/ORDER BY created_at DESC/.test(sql)) {
        return { rows: [...state.imports.values()].filter((row) => row.collection_name === params[0]) };
      }
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
}

async function startIndexServer({ tenants = [syntheticTenant], registryEnv } = {}) {
  const pool = importsPool();
  const registry = createTenantRegistry({
    tenants: tenants.map((make) => make({})),
    env: registryEnv || { DOCS_CHAT_INDEX_KEYS: hashIndexKey("tst-secret") },

    warn() {},
  });
  const app = createDocsChatApp({
    registry,
    env: {},
    pool,
    logger: createLogger({ write() {} }),
    services: () => ({ langfuseService: { enabled: false, createTrace: () => null, async finalizeTrace() {} }, llmClient: {} }),
    indexOverrides: { createEmbeddings: async (inputs) => inputs.map(() => [0, 0, 0]) },
  });
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = "POST", body, token = "tst-secret" } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, base, pool, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("index: auth — missing token 401, wrong token 401; a deployment without index keys is 503 (fail-closed)", async () => {
  const server = await startIndexServer();
  try {
    assert.equal((await server.call("/api/v1/index/imports", { method: "GET", token: null })).status, 401);
    assert.equal((await server.call("/api/v1/index/imports", { method: "GET", token: "wrong" })).status, 401);
    assert.equal((await server.call("/api/v1/index/import", { body: {}, token: null })).status, 401);
    assert.equal((await server.call("/api/v1/index/import", { body: {}, token: "wrong" })).status, 401);
  } finally {
    await server.close();
  }

  const disabled = await startIndexServer({ tenants: [homeTenant], registryEnv: {} });
  try {
    const response = await disabled.call("/api/v1/index/import", { body: {}, token: "anything" });
    assert.equal(response.status, 503);
  } finally {
    await disabled.close();
  }
});

test("index: import runs to active; an archived import can be re-activated (rollback); ownership and unknown ids are 404", async () => {
  const server = await startIndexServer();
  try {
    const started = await server.call("/api/v1/index/import", {
      body: { commitSha: "f505ec9", source: "cli", data: [{ title: "A", text: "a", metadata: { route: "/manual/docs/a" } }, { title: "B", text: "b" }] },
    });
    assert.equal(started.status, 202);
    const { importId, collection, locale } = await started.json();
    assert.deepEqual({ collection, locale }, { collection: "tst-docs-pl", locale: "pl" });
    await server.app.awaitIndexJobs();
    assert.equal(server.pool.state.chunks.length, 2);
    assert.equal(server.pool.state.imports.get(importId).status, "active");

    const again = await server.call(`/api/v1/index/imports/${importId}/activate`, { body: {} });
    assert.equal(again.status, 409, "an active import cannot be activated twice");

    // rollback = aktywacja archiwalnego importu (fake nie archiwizuje sam przy swapie — ustawiamy stan)
    server.pool.state.imports.get(importId).status = "archived";
    const rollback = await server.call(`/api/v1/index/imports/${importId}/activate`, { body: {} });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json()).status, "active");

    for (const missing of ["00000000-0000-4000-8000-999999999999", "imp-404", "undefined"]) {
      const unknown = await server.call(`/api/v1/index/imports/${missing}`, { method: "GET" });
      assert.equal(unknown.status, 404, missing);
    }

    // import innego tenanta: cgc nie ma kluczy (503), ale własność sprawdzamy niezależnie —
    // podmiana kolekcji w stanie fake'a symuluje cudzy import
    server.pool.state.imports.get(importId).collection_name = "ComtegraDocsPL";
    const foreign = await server.call(`/api/v1/index/imports/${importId}/abort`, { body: {} });
    assert.equal(foreign.status, 404);

    const list = await server.call("/api/v1/index/imports", { method: "GET" });
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys((await list.json()).imports), ["pl"]);
  } finally {
    await server.close();
  }
});

test("index: unsupported locale is 400 before any import row exists", async () => {
  const server = await startIndexServer();
  try {
    const response = await server.call("/api/v1/index/import", { body: { locale: "en", data: [{ title: "a", text: "b" }] } });
    assert.equal(response.status, 400);
    assert.equal(server.pool.state.imports.size, 0);
  } finally {
    await server.close();
  }
});

// --- indeksowanie w tle: 202 → pending → active | failed; 409 gdy trwa; shutdown ---
async function startJobServer({ env = {}, poolOptions = {}, createEmbeddings, tenants = [syntheticTenant] } = {}) {
  const pool = importsPool(poolOptions);
  const registry = createTenantRegistry({
    tenants: tenants.map((make) => make({})),
    env: { DOCS_CHAT_INDEX_KEYS: hashIndexKey("tst-secret") },

    warn() {},
  });
  const logLines = [];
  const app = createDocsChatApp({
    registry,
    env,
    pool,
    logger: createLogger({ write: (line) => logLines.push(JSON.parse(line)) }),
    services: () => ({ langfuseService: { enabled: false, createTrace: () => null, async finalizeTrace() {} }, llmClient: {} }),
    indexOverrides: { createEmbeddings: createEmbeddings || (async (inputs) => inputs.map(() => [0, 0, 0])) },
  });
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "POST", body } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer tst-secret" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, pool, call, logLines, close: () => new Promise((resolve) => server.close(resolve)) };
}

const PAGES = [
  { title: "A", text: "a", metadata: { route: "/manual/docs/a", locale: "PL" } },
  { title: "B", text: "b", metadata: { route: "/manual/docs/b", locale: "PL" } },
];

test("import: an embedding failure marks the import failed with the reason; a second import while one runs is 409; the slot is freed", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = await startJobServer({
    createEmbeddings: async () => {
      await gate;
      throw new Error("embeddings unreachable");
    },
  });
  try {
    const first = await server.call("/api/v1/index/import", { body: { data: PAGES } });
    assert.equal(first.status, 202);
    const { importId } = await first.json();
    const second = await server.call("/api/v1/index/import", { body: { data: PAGES } });
    assert.equal(second.status, 409);
    assert.equal(second.headers.get("retry-after"), "60");
    assert.match((await second.json()).error, new RegExp(importId));
    release();
    await server.app.awaitIndexJobs();
    const status = await (await server.call(`/api/v1/index/imports/${importId}`, { method: "GET" })).json();
    assert.equal(status.status, "failed");
    assert.equal(status.error, "embeddings unreachable");
    assert.ok(server.logLines.some((line) => line.msg === "import failed" && line.importId === importId));
    assert.equal((await server.call("/api/v1/index/import", { body: { data: PAGES } })).status, 202, "slot freed after failure");
    await server.app.awaitIndexJobs();
  } finally {
    await server.close();
  }
});

test("import: shutdown aborts a running job and fails its import instead of leaving it pending", async () => {
  const server = await startJobServer({
    createEmbeddings: async (inputs) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inputs.map(() => [0, 0, 0]);
    },
  });
  try {
    // > 50 chunków = dwie partie; przerwanie sprawdzane między partiami
    const data = Array.from({ length: 60 }, (_, index) => ({ title: `P${index}`, text: `p${index}` }));
    const { importId } = await (await server.call("/api/v1/index/import", { body: { data } })).json();
    await server.app.shutdown();
    const row = server.pool.state.imports.get(importId);
    assert.equal(row.status, "failed");
    assert.match(row.error, /aborted/);
  } finally {
    await server.close();
  }
});

test("import: slot is reserved before the first await — a concurrent request gets 409, not a second job", async () => {
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const server = await startJobServer({ poolOptions: { gateImportInsert: () => gate } });
  try {
    const first = server.call("/api/v1/index/import", { body: { data: PAGES } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await server.call("/api/v1/index/import", { body: { data: PAGES } });
    assert.equal(second.status, 409, "second request hits the reservation, not a duplicate job");
    openGate();
    assert.equal((await first).status, 202);
    await server.app.awaitIndexJobs();
    assert.equal(server.pool.state.imports.size, 1);
  } finally {
    await server.close();
  }
});

test("prune runs in the background after a successful activation (import and manual activate)", async () => {
  const server = await startJobServer();
  try {
    await server.call("/api/v1/index/import", { body: { data: PAGES } });
    await server.app.awaitIndexJobs();
    await new Promise((resolve) => setTimeout(resolve, 20)); // prune jest fire-and-forget
    const pruneQueries = server.pool.state.queries.filter((sql) => /Import expired without activation|row_number\(\) OVER/.test(sql));
    assert.ok(pruneQueries.length >= 2, `prune queries observed after import (got ${pruneQueries.length})`);
  } finally {
    await server.close();
  }
});

// --- metryki Prometheus ---
test("GET /metrics exposes counters labeled with the ROUTE PATTERN (not the raw path) and is not logged", async () => {
  const server = await startServer();
  try {
    await fetch(`${server.base}/api/v1/chat`, {
      method: "POST",
      headers: { "x-site-token": SITE_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Jak założyć sprawę?", scope: "all" }),
    });
    const response = await fetch(`${server.base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/plain/);
    const body = await response.text();
    assert.match(body, /docs_chat_http_requests_total\{[^}]*route="\/api\/v1\/chat"[^}]*tenant="tst"[^}]*status="200"/);
    assert.doesNotMatch(body, /route="\/api\/v1\/tst\/chat"/);
    assert.match(body, /docs_chat_http_request_duration_seconds_bucket/);
    assert.ok(!server.logLines.some((line) => line.path === "/metrics"), "scrape requests are not logged");
    assert.ok(server.logLines.some((line) => line.path === "/api/v1/chat"));
  } finally {
    await server.close();
  }
});


test("metrics: unmatched paths never mint label series; /metrics scrapes do not count themselves", async () => {
  const server = await startServer();
  try {
    for (const bogus of ["x1", "x2", "x3"]) {
      await fetch(`${server.base}/api/v1/${bogus}/status`);
    }
    await fetch(`${server.base}/metrics`);
    const body = await (await fetch(`${server.base}/metrics`)).text();
    assert.doesNotMatch(body, /tenant="x[123]"/, "raw URL segments never become tenant labels");
    assert.match(body, /docs_chat_http_requests_total\{method="GET",route="\(unmatched\)",tenant="",status="404"\} 3/);
    assert.doesNotMatch(body, /route="\/metrics"/, "scrapes do not inflate request metrics");
  } finally {
    await server.close();
  }
});

test("health is 503 while the schema is behind the code — readiness gate for the migrate Job", async () => {
  const pool = { async query(sql) { return { rows: sql.includes("schema_migrations") ? [{ name: "001_a.sql" }] : [] }; } };
  const behind = await startServer({ pool, migrations: ["001_a.sql", "002_b.sql"] });
  try {
    const response = await fetch(`${behind.base}/api/v1/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).checks.schema, "behind");
  } finally {
    await behind.close();
  }
  const current = await startServer({ pool, migrations: ["001_a.sql"] });
  try {
    const response = await fetch(`${current.base}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checks.schema, "ok");
  } finally {
    await current.close();
  }
});

test("a client dropping mid-upload is logged as 499, never as an unhandled 500", async () => {
  const server = await startServer();
  try {
    const { port } = new URL(server.base);
    await new Promise((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /api/v1/chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Site-Token: ${SITE_TOKEN}\r\nContent-Length: 100\r\n\r\n{`
        );
        setTimeout(() => {
          socket.destroy();
          resolve(undefined);
        }, 50);
      });
      socket.on("error", reject);
    });
    for (let i = 0; i < 50 && !server.logLines.some((line) => line.msg === "request"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const request = server.logLines.find((line) => line.msg === "request");
    assert.ok(request, "request log line");
    assert.equal(request.status, 499);
    assert.equal(request.error, "client disconnected");
    assert.equal(server.logLines.some((line) => line.msg === "unhandled"), false);
  } finally {
    await server.close();
  }
});

// --- import z eksportera: payload legacy /api/vdb/createCollection, klucz tenanta, praca w tle ---


test("index/import: pages and legacy chunks → 202; the job splits long pages, embeds, activates and prunes; status via GET import", async () => {
  const server = await startJobServer();
  try {
    // ~10,8 tys. znaków > 8000 → dwa chunki po granicy `##`
    const long = `## Sekcja A\n${"słowo ".repeat(900)}\n## Sekcja B\n${"słowo ".repeat(900)}`;
    const started = await server.call("/api/v1/index/import", {
      body: {
        collectionName: "tst-docs-pl",
        source: "cgc-user-docs",
        commitSha: "abc123",
        data: [
          { title: "Zakładanie sprawy", text: "Sprawę zakładasz w module Kwestie.", file_path: "docs/sprawy.md", metadata: { route: "/manual/docs/sprawy" } },
          { title: "Podpis", text: "Podpis kwalifikowany składasz w oknie podpisu." },
          { title: "Długi", text: long, metadata: { route: "/manual/docs/dlugi" } },
          // chunk już podzielony przez eksporter cgc-user-docs: przechodzi bez zmian
          { title: "Legacy - part 2/2", text: "# Legacy\nogon", metadata: { chunked: true, chunk_index: 1, chunk_count: 2, source_title: "Legacy" } },
        ],
      },
    });
    assert.equal(started.status, 202);
    const body = await started.json();
    assert.equal(body.collection, "tst-docs-pl");
    assert.equal(body.locale, "pl");
    assert.equal(body.documents, 4);

    await server.app.awaitIndexJobs();
    const status = await server.call(`/api/v1/index/imports/${body.importId}`, { method: "GET" });
    const imported = await status.json();
    assert.equal(imported.status, "active");
    assert.equal(imported.documents, 5, "2 krótkie + 2 chunki długiej strony + 1 legacy");
    assert.equal(imported.commitSha, "abc123");
    assert.equal(imported.source, "import:cgc-user-docs");
    assert.ok(server.logLines.some((line) => line.msg === "import" && /documents: 4, chunks: 5/.test(line.message)));
    assert.ok(server.logLines.some((line) => line.msg === "import" && /active: 5 chunks/.test(line.message)));
    const titles = server.pool.state.chunks.filter((chunk) => chunk.importId === body.importId).map((chunk) => chunk.title);
    assert.deepEqual(titles, ["Zakładanie sprawy", "Podpis", "Długi - part 1/2", "Długi - part 2/2", "Legacy - part 2/2"]);
  } finally {
    await server.close();
  }
});

test("index/import: collection must belong to the tenant, payload validated before any import is created, locale fallback works", async () => {
  const server = await startJobServer();
  try {
    const foreign = await server.call("/api/v1/index/import", { body: { collectionName: "ComtegraDocsPL", data: [{ title: "x", text: "y" }] } });
    assert.equal(foreign.status, 400);
    assert.match((await foreign.json()).error, /collectionName must be one of: tst-docs-pl/);

    const invalid = await server.call("/api/v1/index/import", { body: { collectionName: "tst-docs-pl", data: [{ title: "", text: "y" }] } });
    assert.equal(invalid.status, 400);
    const empty = await server.call("/api/v1/index/import", { body: { collectionName: "tst-docs-pl", data: [] } });
    assert.equal(empty.status, 400);
    assert.equal(server.pool.state.imports.size, 0, "no import row for rejected payloads");

    // bez collectionName: locale (domyślnie defaultLocale tenanta)
    const byLocale = await server.call("/api/v1/index/import", { body: { data: [{ title: "a", text: "b" }] } });
    assert.equal(byLocale.status, 202);
    assert.equal((await byLocale.json()).collection, "tst-docs-pl");
    await server.app.awaitIndexJobs();
  } finally {
    await server.close();
  }
});

test("index/import: more documents than the sanity cap → 400 and no import row", async () => {
  const server = await startJobServer();
  try {
    const data = Array.from({ length: 5001 }, (_, index) => ({ title: `d${index}`, text: "x" }));
    const response = await server.call("/api/v1/index/import", { body: { data } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /at most 5000 documents/);
    assert.equal(server.pool.state.imports.size, 0);
  } finally {
    await server.close();
  }
});

// --- admin prompt (PUT /api/v1/{tenant}/admin/prompt, Bearer klucz indeksu) ---
// Live-apply fail-closed: walidacja PRZED zapisem, plik = jedyne źródło prawdy, prompt obowiązuje
// od następnego pytania (handler czyta promptText z tenanta per request).

const ADMIN_INDEX_KEY = "cgc-admin-index-key";

async function startAdminPromptServer({ withPromptFile = true, promptEcho = false, fromEnvConfig = false } = {}) {
  const promptPath = withPromptFile || fromEnvConfig ? join(mkdtempSync(join(tmpdir(), "docs-chat-prompt-")), "prompt.md") : null;
  const env = {
    ...SITE_TOKEN_ENV,
    DOCS_CHAT_INDEX_KEYS: hashIndexKey(ADMIN_INDEX_KEY),
    // fromEnvConfig: celowo BEZ DOCS_CHAT_PROMPT_FILE — sciezke rozwiazuje envConfig (default)
    ...(promptPath && !fromEnvConfig ? { DOCS_CHAT_PROMPT_FILE: promptPath } : {}),
  };
  const registry = createTenantRegistry({
    tenants: [
      fromEnvConfig
        ? tenantConfigFromEnv(env, { defaultPromptFile: promptPath || undefined, warn() {} })
        : homeTenant(env),
    ],
    env,
    warn() {},
  });
  /** @type {any[]} */
  const seenPrompts = [];
  const app = createDocsChatApp({
    registry,
    env,
    pool: { async query() { return { rows: [] }; } },
    logger: createLogger({ write() {} }),
    services: () => ({ langfuseService: { enabled: false, createTrace: () => null, async finalizeTrace() {} }, llmClient: {} }),
    handlerOverrides: {
      checkRateLimit: async () => ({ allowed: true }),
      retrieveContext: async () => [DOC],
      streamCompletion: async function* (input) {
        seenPrompts.push(input.promptText);
        yield { type: "content", content: promptEcho ? String(input.promptText ?? "<none>") : "OK" };
      },
    },
  });
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const putPrompt = (body, { token = ADMIN_INDEX_KEY, contentType = "text/plain" } = {}) =>
    fetch(`${base}/api/v1/admin/prompt`, {
      method: "PUT",
      headers: { "content-type": contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
  const chat = () =>
    fetch(`${base}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Jak założyć sprawę?", scope: "all", client: "r-1" }),
    });
  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    if (promptPath) rmSync(dirname(promptPath), { recursive: true, force: true });
  };
  return { base, registry, env, promptPath, seenPrompts, putPrompt, chat, close: cleanup };
}

test("admin/prompt: auth first — missing/wrong key 401, unknown tenant 404, wrong content-type 415", async () => {
  const server = await startAdminPromptServer();
  try {
    assert.equal((await server.putPrompt("New rules.", { token: null })).status, 401);
    assert.equal((await server.putPrompt("New rules.", { token: "wrong" })).status, 401);
    const asJson = await fetch(`${server.base}/api/v1/admin/prompt`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_INDEX_KEY}` },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(asJson.status, 415);
    const unknown = await fetch(`${server.base}/api/v1/nobody/admin/prompt`, {
      method: "PUT",
      headers: { "content-type": "text/plain", authorization: `Bearer ${ADMIN_INDEX_KEY}` },
      body: "New rules.",
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("admin/prompt: validation fail-closed — empty 400, oversized 400, </docs_context> 400; file never touched", async () => {
  const server = await startAdminPromptServer();
  try {
    assert.equal((await server.putPrompt("   ")).status, 400);
    assert.equal((await server.putPrompt("x".repeat(8001))).status, 400);
    assert.equal((await server.putPrompt("Rules that close </docs_context> smuggle")).status, 400);
    assert.equal((await server.putPrompt("x".repeat(33 * 1024 + 1))).status, 413);
    assert.ok(!existsSync(server.promptPath), "no request above wrote the file");
  } finally {
    await server.close();
  }
});

test("admin/prompt: writes the file and applies live — next chat answers with the new prompt", async () => {
  const server = await startAdminPromptServer({ promptEcho: true });
  try {
    const before = await server.chat();
    const beforeFrames = await readSse(before);
    assert.equal(beforeFrames.find((frame) => frame.type === "content").content, "<none>");

    const updated = await server.putPrompt("New grounding rules for the tenant.");
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.deepEqual(body, { ok: true, tenant: "cgc", chars: "New grounding rules for the tenant.".length, applied: "live" });
    assert.equal(readFileSync(server.promptPath, "utf8").trim(), "New grounding rules for the tenant.");
    assert.equal(server.registry.get("cgc").promptText, "New grounding rules for the tenant.");

    const after = await server.chat();
    const afterFrames = await readSse(after);
    assert.equal(afterFrames.find((frame) => frame.type === "content").content, "New grounding rules for the tenant.");
    assert.equal(server.seenPrompts.at(-1), "New grounding rules for the tenant.");
  } finally {
    await server.close();
  }
});

test("admin/prompt: tenant without a prompt file (inline, no env) → 409; env-config tenants always carry one", async () => {
  const server = await startAdminPromptServer({ withPromptFile: false });
  try {
    const response = await server.putPrompt("Any text.");
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /no prompt file/);
  } finally {
    await server.close();
  }
});

test("admin/prompt: env-config tenant without DOCS_CHAT_PROMPT_FILE → PUT writes the DEFAULT path (created at boot) — docs contract", async () => {
  // kontrakt z user-docs: instalacja na 2 sekrety, curl z dokumentacji dziala od razu
  const server = await startAdminPromptServer({ fromEnvConfig: true, promptEcho: true });
  try {
    // boot (createTenantRegistry) utworzyl defaultowy prompt.md na wstrzykniętej sciezce
    assert.ok(existsSync(server.promptPath), "boot created the default prompt file");
    const response = await server.putPrompt("Prywatny prompt Asystenta Garden.");
    assert.equal(response.status, 200);
    assert.match(await readFile(server.promptPath, "utf8"), /Asystenta Garden/);
    // live-apply: nastepne pytanie idzie z nowym promptem
    await server.chat();
    assert.match(server.seenPrompts.at(-1), /Asystenta Garden/);
  } finally {
    await server.close();
  }
});
