// @ts-check
// Adapter node:http → interfejs, którego oczekują fabryki handlerów (`res.status().json()`,
// `req.body`). Handlery docs-chat/feedback były pisane pod Next Pages API; ten moduł pozwala
// uruchomić je w czystym Node (server/docs-chat-api.mjs) bez Nexta, jego limitu body 1 MB,
// middleware i i18n. sseWriter używa wyłącznie natywnych pól/metod ServerResponse.

import { Buffer } from "node:buffer";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */

/**
 * Błąd HTTP z kodem statusu — router odpowiada nim jako JSON `{ error }`.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Klient zerwał połączenie, zanim serwer odebrał żądanie — obsługa: cisza (app.mjs). */
export class ClientDisconnectedError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

/**
 * Dodaje `status(code)` (chainable) i `json(payload)` do natywnej odpowiedzi.
 * @template {ServerResponse} T
 * @param {T} res
 * @returns {T & { status: (code: number) => T & { json: (payload: unknown) => void, end: ServerResponse["end"] }, json: (payload: unknown) => void }}
 */
export function enhanceResponse(res) {
  const enhanced = /** @type {any} */ (res);
  enhanced.status = (/** @type {number} */ code) => {
    res.statusCode = code;
    return enhanced;
  };
  enhanced.json = (/** @type {unknown} */ payload) => {
    const body = JSON.stringify(payload);
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    }
    res.end(body);
  };
  return enhanced;
}

/**
 * Czyta body żądania z twardym limitem bajtów (413 po przekroczeniu — bez buforowania reszty)
 * i parsuje JSON, gdy Content-Type to application/json. Brak body → `{}` (GET/OPTIONS).
 * @param {IncomingMessage} req
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return {};
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body must be at most ${maxBytes} bytes`);
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        throw new HttpError(413, `Request body must be at most ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    // klient zerwał w trakcie wysyłania body (Node: 'aborted' / ECONNRESET) — to nie jest błąd
    // serwera: bez odpowiedzi, bez wpisu 5xx w metrykach (alert 5xx-ratio) ani "unhandled" w logu
    if (error instanceof HttpError) throw error;
    const code = /** @type {any} */ (error)?.code;
    if (req.destroyed || code === "ECONNRESET" || code === "ECONNABORTED" || /** @type {any} */ (error)?.message === "aborted") {
      throw new ClientDisconnectedError();
    }
    throw error;
  }
  if (received === 0) {
    return {};
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

/**
 * Czyta RAW body jako tekst UTF-8 z twardym limitem bajtów (413 po przekroczeniu — bez
 * buforowania reszty) i wymaganym Content-Type (415 przy niezgodnym). Brak body → "".
 * Używane przez admin API (PUT /api/v1/admin/prompt — text/plain, pełna treść pliku).
 * @param {IncomingMessage} req
 * @param {{ maxBytes?: number, contentType?: string }} [options]
 * @returns {Promise<string>}
 */
export async function readTextBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? 32 * 1024;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return "";
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body must be at most ${maxBytes} bytes`);
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (options.contentType && !contentType.includes(options.contentType)) {
    throw new HttpError(415, `Content-Type must be ${options.contentType}`);
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        throw new HttpError(413, `Request body must be at most ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = /** @type {any} */ (error)?.code;
    if (req.destroyed || code === "ECONNRESET" || code === "ECONNABORTED" || /** @type {any} */ (error)?.message === "aborted") {
      throw new ClientDisconnectedError();
    }
    throw error;
  }
  if (received === 0) {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ścieżka bez query stringa i bez końcowego "/" (poza rootem); odrzuca sekwencje `..`.
 * @param {string|undefined} url
 */
export function normalizePath(url) {
  const raw = String(url || "/");
  const path = raw.split("?")[0].split("#")[0];
  if (path.includes("..")) {
    return null;
  }
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}
