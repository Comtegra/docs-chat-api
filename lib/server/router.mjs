// @ts-check
// Minimalny router: metoda + wzorzec ścieżki z parametrami `:name` → handler. Bez zależności.
// Segment parametru musi pasować do [A-Za-z0-9._-]+ (id tenanta/importu) — reszta = 404.

/** @typedef {(req: any, res: any, params: Record<string, string>) => Promise<void>|void} RouteHandler */

const PARAM_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {Object} RouteMatch
 * @property {RouteHandler} [handler]
 * @property {Record<string, string>} [params]
 * @property {string} [pattern]     wzorzec trasy (np. /api/v1/chat) — etykieta metryk
 * @property {string[]} [allowed]   metody dostępne dla ścieżki (405), gdy brak handlera dla metody
 */

export function createRouter() {
  /** @type {Array<{ method: string, pattern: string, segments: string[], handler: RouteHandler }>} */
  const routes = [];

  /**
   * @param {string} method
   * @param {string} pattern  np. "/api/v1/chat"
   * @param {RouteHandler} handler
   */
  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), pattern, segments: pattern.split("/").filter(Boolean), handler });
  }

  /**
   * @param {string[]} segments
   * @param {string[]} pathSegments
   * @returns {Record<string, string>|null}
   */
  function matchSegments(segments, pathSegments) {
    if (segments.length !== pathSegments.length) {
      return null;
    }
    /** @type {Record<string, string>} */
    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const actual = pathSegments[index];
      if (segment.startsWith(":")) {
        if (!PARAM_SEGMENT.test(actual)) {
          return null;
        }
        params[segment.slice(1)] = actual;
      } else if (segment !== actual) {
        return null;
      }
    }
    return params;
  }

  /**
   * @param {string} method
   * @param {string} path  znormalizowana ścieżka (lib/server/http.mjs normalizePath)
   * @returns {RouteMatch|null}  null = 404
   */
  function match(method, path) {
    const pathSegments = path.split("/").filter(Boolean);
    const upper = method.toUpperCase();
    /** @type {string[]} */
    const allowed = [];
    for (const route of routes) {
      const params = matchSegments(route.segments, pathSegments);
      if (!params) {
        continue;
      }
      if (route.method === upper) {
        return { handler: route.handler, params, pattern: route.pattern };
      }
      allowed.push(route.method);
    }
    return allowed.length > 0 ? { allowed: [...new Set(allowed)] } : null;
  }

  return { add, match };
}
