// @ts-check
import { queryDocuments } from "../vdb/documents.mjs";
import { createQueryEmbedding } from "../embeddings.mjs";
import { routeFromMetadata } from "../vdb/route.mjs";
import { toSnippet } from "../vdb/snippet.mjs";

/**
 * Obiekty użyteczne dla LLM i dla kart = mające niepusty `properties.text`.
 * JEDNO miejsce filtrowania — dzięki temu numeracja `[n]` w kontekście i indeksy w ramce
 * `sources` są zawsze spójne (dawniej filtrował tylko buildContextText → dryf numeracji).
 * @param {any[]} objects
 * @returns {any[]}
 */
export function filterUsableObjects(objects) {
  return (objects || []).filter(
    (object) => typeof object?.properties?.text === "string" && object.properties.text.trim()
  );
}

/**
 * Kontekst dla modelu: fragmenty ponumerowane `[1] …`, w kolejności `sources`
 * (numer = indeks + 1) — na tym opiera się instrukcja cytowania w system promptcie.
 * @param {any[]} objects  wynik filterUsableObjects()
 */
export function buildContextText(objects) {
  return objects
    // zaindeksowana strona nie może „wyłamać się" z sekcji danych promptu (indirect injection);
    // także warianty z białymi znakami/atrybutami (`</DOCS_CONTEXT >`), które model czyta jak tag;
    // atrybuty ograniczone do 256 znaków — bez limitu niedomknięte tagi dawały kwadratowy czas
    .map((object, index) => `[${index + 1}] ${String(object.properties.text).replace(/<\s*\/?\s*docs_context\b[^>]{0,256}>/gi, "")}`)
    .join("\n\n---\n\n");
}

/**
 * Ramka `sources` (kontrakt SSE v2, lib/chat/sse.mjs SseSource).
 * - `route`: `metadata.route` z ingestu (permalink docs), ZDEKODOWANA (stare wiersze mają
 *   `%20`), albo null (np. web-info bez trasy); bez fallbacku z `file_path` — Docusaurus
 *   indeksuje tylko `index|readme|<dirname>`, więc zgadywanie trasy z pliku dawało złe linki.
 * - `url`: kompatybilność z żywym klientem docs sprzed E2 (relatywny = route; przeglądarka
 *   koduje spacje w href); do usunięcia po E2.
 * - `snippet`: czysty tekst z jednego serwerowego toSnippet (świadomy overlapu chunków).
 * - `score`: surowe RRF, informacyjne (UI nie renderuje paska trafności — plan §1).
 * @param {any[]} objects  wynik filterUsableObjects()
 * @returns {import("../chat/sse.mjs").SseSource[]}
 */
export function buildSources(objects) {
  return objects.map((object) => {
    const metadata = object.properties?.metadata || {};
    // zdekodowana, surowa trasa (jak permalink Docusaurusa) — niezależnie od wieku wiersza
    // tylko trasa względna (permalink) — metadata z legacy importu jest niezaufana, a `url`
    // trafia do href w widgecie (javascript:/https://evil odrzucone tutaj, nie tylko w kliencie)
    const rawRoute = routeFromMetadata(metadata);
    const route = typeof rawRoute === "string" && /^\/(?![\/\\])/.test(rawRoute) ? rawRoute : null;
    // kotwica sekcji/pytania FAQ (chunker albo eksporter) trafia tylko do href — `route` zostaje
    // czystym permalinkiem (zakres „ta strona" porównuje go z trasą klienta)
    const anchor = typeof metadata.anchor === "string" && /^[\p{L}\p{N}_%.~-]{1,200}$/u.test(metadata.anchor) ? `#${metadata.anchor}` : "";
    return {
      title:
        metadata.sourceTitle ||
        metadata.source_title ||
        object.properties?.title ||
        object.properties?.file_path ||
        "Documentation",
      route,
      url: route ? `${route}${anchor}` : null,
      snippet: toSnippet(object.properties?.text, 240, { chunkIndex: metadata.chunk_index }),
      score: object.score,
    };
  });
}

/**
 * Kolekcja tenanta dla locale żądania (locale z walidacji jest wielkimi literami, rejestr
 * trzyma małe). Brak kolekcji dla locale = błąd konfiguracji, nie „pusta odpowiedź".
 * @param {import("../tenants/registry.mjs").TenantConfig} tenant
 * @param {string} locale
 */
export function collectionForLocale(tenant, locale) {
  const key = String(locale || "").toLowerCase();
  const collectionName = tenant.collections[key];
  if (!collectionName) {
    throw new Error(`Tenant "${tenant.id}" has no collection for locale "${key}"`);
  }
  return collectionName;
}

/**
 * @param {{ prompt: string, locale: string, scope: "page"|"all", page?: { sourceFilePath?: string|null, route?: string|null } }} request
 * @param {{ llmClient?: any, env?: Record<string, string|undefined>, signal?: AbortSignal, tenant?: import("../tenants/registry.mjs").TenantConfig, limit?: number, queryOptions?: Record<string, unknown> }} [options]
 *   `tenant` — jawna kolekcja i wagi fuzji z rejestru; bez niego ścieżka legacy (kolekcja po języku).
 */
export async function retrieveDocsChatContext(request, options = {}) {
  const pageScoped = request.scope === "page";
  const tenant = options.tenant;

  return queryDocuments(
    {
      query: request.prompt,
      language: request.locale,
      collectionName: tenant ? collectionForLocale(tenant, request.locale) : null,
      // zakres strony: po `route` (permalink z klienta; klient po E2 nie ma `source`)
      // i/lub po `sourceFilePath` (klient sprzed E2) — oba filtry OR-owane w SQL
      sourceFilePath: pageScoped ? request.page?.sourceFilePath ?? null : null,
      route: pageScoped ? request.page?.route ?? null : null,
      limit: options.limit || tenant?.retrieval.limit || 5,
    },
    {
      ...(tenant
        ? { vectorWeight: tenant.retrieval.vectorWeight, textWeight: tenant.retrieval.textWeight }
        : {}),
      // Embedding PYTANIA kluczem tenanta (koszt per klient — gateway billinguje per klucz).
      // Nadpisujemy TAKŻE bez tenanta (ścieżka legacy z `client: undefined` → domyślny klient
      // procesu), żeby zerwanie połączenia i timeout 15 s obowiązywały wszędzie — inaczej pytanie
      // wisiałoby na ponowieniach SDK, trzymając slot semafora.
      createEmbedding: (/** @type {string} */ query) =>
        createQueryEmbedding(query, { client: options.llmClient, env: options.env, signal: options.signal }),
      ...(options.queryOptions || {}),
    }
  );
}
