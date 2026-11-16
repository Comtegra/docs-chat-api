// Współdzielone mocki dla testów writerów/handlerów SSE (node:test, bez jsdom).
import { EventEmitter } from "node:events";

// Mock `res` wierny semantyce Node: writableEnded po end(), destroyed po zerwaniu,
// 'close' emitowane w obu przypadkach (po end() z writableEnded=true, po zerwaniu z false).
export function createSseRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(statusCode, headers) {
      // Node rzuca synchronicznie przy drugim writeHead — mock musi to egzekwować
      if (this.headersSent) {
        throw Object.assign(new Error("Cannot write headers after they are sent"), {
          code: "ERR_HTTP_HEADERS_SENT",
        });
      }
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    write(chunk) {
      if (this.writableEnded) {
        // w Node: emitowany 'error' ERR_STREAM_WRITE_AFTER_END (niezłapany = crash) — tu rzucamy
        throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      }
      if (this.destroyed) {
        // Node: zapis na zniszczonym strumieniu jest cicho odrzucany
        return false;
      }
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
      // Node: 'close' po normalnym zakończeniu — writableEnded już true
      this.emit("close");
    },
    // zerwanie połączenia przez klienta w trakcie strumienia
    simulateClientDisconnect() {
      this.destroyed = true;
      this.emit("close");
    },
    // pomocnicze do asercji
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      this.writableEnded = true;
      return this;
    },
  });
  return res;
}

export function parseFrames(chunks) {
  return chunks
    .join("")
    .split("\n\n")
    .filter((block) => block && !block.startsWith(":")) // komentarze SSE (heartbeat) jak w prawdziwym parserze
    .map((line) => JSON.parse(line.replace(/^data: /, "")));
}
