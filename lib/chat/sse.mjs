// @ts-check
// Ramki strumienia SSE — wspólny kontrakt v2 czatu (serwis docs-chat-api i klienci).
// Buforuje niedokończone linie między chunkami — fetch może rozciąć
// "data: {...}" w dowolnym miejscu, a stary kod inline gubił takie eventy.
//
// Kontrakt ramek SSE v2 (plan docs/ai-native-ui-plan.md §4.2). Reguła: jedna linia
// `data: <json>` = jedna ramka. Parser zwraca obiekt; dispatch po `type` robi
// konsument (hook / reducer), nie parser. Od E1a oba writery (lib/chat/sseWriter.mjs)
// wysyłają wyłącznie ramki typowane; od E1b `sources` niesie `route` (zdekodowany permalink
// docs albo null) i `snippet` (tekst z lib/vdb/snippet.mjs); `url` = kompat dla klienta
// docs sprzed E2 (relatywny, = route) — do usunięcia po E2.

/** @typedef {{ title: string, route: string|null, url: string|null, snippet: string, score: number }} SseSource */
/** @typedef {{ type: "sources", sources: SseSource[] }} SseSourcesFrame */
/** @typedef {{ type: "step", id: string, status: "running"|"done"|"failed", meta?: Record<string, unknown> }} SseStepFrame */
/** @typedef {{ type: "reasoning", content: string }} SseReasoningFrame */
/** @typedef {{ type: "content", content: string }} SseContentFrame */
/** `traceId` = null, gdy obserwowalność (Langfuse) jest wyłączona — klient nie pokazuje wtedy feedbacku */
/** @typedef {{ type: "done", traceId: string|null, aiGenerated?: boolean }} SseDoneFrame */  // aiGenerated: oznaczenie AI Act z gatewaya (addytywne)
/** @typedef {{ type: "error", code: "invalid_request"|"rate_limited"|"no_context"|"llm_error", message?: string }} SseErrorFrame */
/** @typedef {SseSourcesFrame|SseStepFrame|SseReasoningFrame|SseContentFrame|SseDoneFrame|SseErrorFrame} SseFrame */

/**
 * @returns {(chunkText: string) => Array<Record<string, unknown>>} push — zwraca sparsowane ramki z chunka
 */
export function createSseParser() {
  let buffer = "";

  return function push(chunkText) {
    buffer += chunkText;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // split() zawsze zwraca ≥1 element; `?? ""` tylko dla typów

    const events = [];
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // niedomknięty/uszkodzony JSON w pojedynczej linii — pomijamy
      }
    }
    return events;
  };
}
