// @ts-check
// Logi strukturalne (JSON, jedna linia) dla serwisu API. Bez adresów IP i bez treści pytań
// (dane osobowe) — do korelacji służy traceId (ten sam, co w Langfuse).

/**
 * @typedef {Object} LogEntry
 * @property {"info"|"warn"|"error"} level
 * @property {string} msg
 * @property {Record<string, unknown>} [fields]
 */

/**
 * @param {{ write?: (line: string) => void, now?: () => Date, service?: string }} [options]
 */
export function createLogger(options = {}) {
  const write = options.write || ((line) => process.stdout.write(`${line}\n`));
  const now = options.now || (() => new Date());
  const service = options.service || "docs-chat-api";

  /**
   * @param {"info"|"warn"|"error"} level
   * @param {string} msg
   * @param {Record<string, unknown>} [fields]
   */
  function log(level, msg, fields = {}) {
    write(JSON.stringify({ ts: now().toISOString(), level, service, msg, ...fields }));
  }

  return {
    info: (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => log("info", msg, fields),
    warn: (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => log("warn", msg, fields),
    error: (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => log("error", msg, fields),
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */
