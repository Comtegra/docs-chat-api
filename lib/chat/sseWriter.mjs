// @ts-check
// Wspólny writer SSE obu czatów (site-chat i docs-chat) — plan docs/ai-native-ui-plan.md §4.2.
// Kontrakt ramek: lib/chat/sse.mjs (typedef SseFrame). Jedna linia `data: <json>` = jedna ramka.
//
// Dwie pułapki Node/Next, które ten moduł zamyka w jednym miejscu:
// 1. write-after-end: `res.write()` po `res.end()` na keep-alive = niezłapane
//    ERR_STREAM_WRITE_AFTER_END = crash procesu. Każdy zapis przechodzi przez guard.
// 2. abort: w Next Pages API route `req` jest już zniszczony po sparsowaniu body, więc
//    `req.on("close")` NIGDY nie odpala. Zerwanie klienta widać na `res` ('close' z
//    `writableEnded === false`); 'close' po normalnym `res.end()` ma `writableEnded === true`.

/** @typedef {import("node:http").ServerResponse} SseResponse */
/** @typedef {import("./sse.mjs").SseFrame} SseFrame */
/** @typedef {import("./sse.mjs").SseErrorFrame["code"]} SseErrorCode */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // wyłącza buforowanie w nginx/ingress — bez tego strumień dociera paczkami
  "X-Accel-Buffering": "no",
};

/** odstęp heartbeatu: poniżej 30 s (timeout ciszy w kliencie www i w widgecie) i 60 s (idle ingressu) */
export const SSE_HEARTBEAT_MS = 10_000;

/**
 * Otwiera strumień SSE (status 200 + nagłówki) i uruchamia heartbeat: komentarz SSE (`: ping`)
 * co `heartbeatMs`, dopóki strumień żyje. Klienci mają timeout CISZY 30 s (www: useCgcChat,
 * widget: useDocsChat), a serwer czeka na pierwszy token do 55 s — bez heartbeatu klient zrywał
 * po 30 s pytanie, które model właśnie zaczynał generować (gateway i tak je rozliczał).
 * Komentarz jest niewidoczny dla parserów (linia bez `data: `), ale resetuje ich zegar aktywności.
 * Wołać dokładnie raz, przed pierwszą ramką.
 * @param {SseResponse} res
 * @param {{ heartbeatMs?: number }} [options]  0 = bez heartbeatu
 */
export function startSse(res, options = {}) {
  res.writeHead(200, SSE_HEADERS);
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  if (!(heartbeatMs > 0)) return;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(": ping\n\n");
  }, heartbeatMs);
  // unref: heartbeat nie ma prawa trzymać procesu przy życiu (pętlę trzyma nasłuchujący serwer;
  // w testach niezamknięty mock `res` nie może wieszać runnera). To NIE jest przypadek z health
  // checku, gdzie unref'nięty timer musiał odpalić, by rozstrzygnąć obietnicę.
  timer.unref?.();
  // 'close' przychodzi zarówno po end(), jak i po zerwaniu — jedno miejsce sprzątania
  res.on("close", () => clearInterval(timer));
}

/**
 * Wysyła jedną ramkę. Nie pisze po `end()`/zerwaniu (guard write-after-end).
 * @param {SseResponse} res
 * @param {SseFrame} frame
 * @returns {boolean} true, jeśli ramka została zapisana
 */
export function writeSse(res, frame) {
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
  return true;
}

/**
 * Kończy strumień, jeśli jeszcze nie zakończony (idempotentne). Wołane także po zerwaniu
 * klienta (`destroyed`): `end()` na zniszczonym strumieniu jest w Node bezpieczne, a bez
 * niego Next loguje „API resolved without sending a response" i traktuje request jako zawieszony.
 * @param {SseResponse} res
 */
export function endSse(res) {
  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * Wysyła ramkę błędu i zamyka strumień.
 * @param {SseResponse} res
 * @param {SseErrorCode} code
 * @param {string} [message]
 * @returns {boolean} true, jeśli ramka została zapisana
 */
export function sendSseError(res, code, message) {
  const wrote = writeSse(
    res,
    message === undefined ? { type: "error", code } : { type: "error", code, message }
  );
  endSse(res);
  return wrote;
}

/**
 * Zwraca AbortController, który przerywa się przy zerwaniu połączenia przez klienta
 * (i TYLKO wtedy — 'close' po normalnym `end()` jest ignorowane dzięki guardowi).
 * `signal` przekazać do `client.chat.completions.create(body, { signal })`.
 *
 * Uwaga: przy abort w trakcie strumienia SDK OpenAI nie rzuca — iterator kończy się
 * „normalnie". Po pętli `for await` trzeba sprawdzić `controller.signal.aborted`.
 *
 * Podpinać JAK NAJWCZEŚNIEJ (przed limiterem/retrievalem), a przed wywołaniem LLM
 * sprawdzić `signal.aborted`: zerwanie w fazie przed strumieniem też ma oszczędzić
 * wywołanie modelu. Jeśli `res` jest już zniszczone przy podpięciu ('close' poleciało
 * wcześniej), kontroler jest przerywany natychmiast.
 * @param {SseResponse} res
 * @returns {AbortController}
 */
export function attachAbort(res) {
  const controller = new AbortController();
  if (res.destroyed) {
    controller.abort();
    return controller;
  }
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });
  return controller;
}
