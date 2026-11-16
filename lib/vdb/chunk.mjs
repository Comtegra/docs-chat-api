// @ts-check
// Dzielenie dokumentu na chunki indeksu — port 1:1 z cgc-user-docs/python/md_to_json.py
// (split_text_units → pack_units → add_overlap), żeby heurystyki snippetów w lib/vdb/snippet.mjs
// (overlap 300, pusta linia przed doklejonym ogonem) działały tak samo dla każdego źródła.
// Dzieli SERWER przy imporcie: eksporter wysyła całe strony ({title, text, metadata.route}),
// a chunki już podzielone przez eksporter cgc-user-docs (metadata.chunked) przechodzą bez zmian.
// Dokument ≤ max_chars idzie w całości (bez metadanych chunk_*).
//
// `metadata.anchor` = id nagłówka h2, którym chunk się zaczyna — źródło w odpowiedzi może linkować
// do sekcji (`route#anchor`). Id z `headings` dokumentu, a bez nich — slug jak w Docusaurusie.

export const DEFAULT_MAX_CHUNK_CHARS = 8000;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 300;

/**
 * @typedef {Object} IndexDocument
 * @property {string} title
 * @property {string} text
 * @property {string|null} file_path
 * @property {Record<string, unknown>} metadata
 */

/**
 * @param {string} text
 * @param {number} maxChars
 */
function hardSplitText(text, maxChars) {
  /** @type {string[]} */
  const parts = [];
  for (let index = 0; index < text.length; index += maxChars) {
    parts.push(text.slice(index, index + maxChars));
  }
  return parts;
}

/**
 * @param {string} block
 * @param {number} maxChars
 */
function splitOversizedBlock(block, maxChars) {
  if (block.length <= maxChars) {
    return [block];
  }
  /** @type {string[]} */
  const parts = [];
  for (const paragraph of block.split(/(\n\s*\n)/)) {
    if (!paragraph) continue;
    if (paragraph.length <= maxChars) {
      parts.push(paragraph);
    } else {
      parts.push(...hardSplitText(paragraph, maxChars));
    }
  }
  return parts;
}

/**
 * @param {string} text
 * @param {number} maxChars
 */
export function splitTextUnits(text, maxChars) {
  /** @type {string[]} */
  const units = [];
  for (const section of text.split(/(?=\n##\s+)/)) {
    if (section) {
      units.push(...splitOversizedBlock(section, maxChars));
    }
  }
  return units;
}

/**
 * @param {string[]} units
 * @param {number} maxChars
 */
export function packUnits(units, maxChars) {
  /** @type {string[]} */
  const chunks = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (current.length + unit.length <= maxChars) {
      current += unit;
      continue;
    }
    chunks.push(current.trim());
    current = unit;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

/**
 * @param {string[]} chunks
 * @param {number} overlapChars
 * @param {number} maxChars
 */
export function addOverlap(chunks, overlapChars, maxChars) {
  if (overlapChars <= 0 || chunks.length <= 1) {
    return chunks;
  }
  const overlapped = [chunks[0]];
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    // obie strony są .trim()owane przez packUnits — łączymy pustą linią, inaczej ogon poprzedniego
    // chunka klei się do nagłówka („…koniec.## Nagłówek") i psuje heurystykę snippetów
    const availableOverlap = Math.max(0, Math.min(overlapChars, maxChars - current.length - 2));
    const prefix = availableOverlap ? `${previous.slice(-availableOverlap)}\n\n` : "";
    overlapped.push((prefix + current).trim());
  }
  return overlapped;
}

/**
 * Id kotwicy pierwszego nagłówka `## …` w tekście chunka. Wołane na chunkach SPRZED doklejenia
 * overlapu (chunkDocument) — nagłówek z ogona poprzedniego chunka nie może zostać kotwicą.
 * @param {string} chunkText
 * @param {Array<{ text: string, id: string }>} headings
 */
function anchorForChunk(chunkText, headings) {
  const match = chunkText.match(/^##\s+(.+)$/m);
  if (!match) return null;
  const headingText = match[1].trim();
  const found = headings.find((heading) => heading.text === headingText);
  return found ? found.id : slugifyHeading(headingText);
}

/**
 * Id kotwicy nagłówka jak w Docusaurusie (github-slugger): jawne `{#id}` wygrywa; inaczej małe
 * litery, znaki spoza liter/cyfr/spacji/`-`/`_` usunięte, spacje → `-`. Bez deduplikacji
 * powtórzonych nagłówków (Docusaurus dokleja `-1`) — kotwica jest podpowiedzią, nie kluczem.
 * @param {string} heading
 */
export function slugifyHeading(heading) {
  const explicit = heading.match(/\{#([^}]+)\}\s*$/);
  if (explicit) return explicit[1].trim();
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * @param {{ title: string, text: string, file_path?: string|null, metadata?: Record<string, unknown>, headings?: Array<{ text: string, id: string }> }} document
 *   `text` — treść strony; `# title` doklejany, gdy tekst nie zaczyna się nagłówkiem H1 (eksporter
 *   cgc-user-docs wysyła go sam). `metadata.chunked === true` = już podzielony, przechodzi bez zmian.
 * @param {{ maxChars?: number, overlapChars?: number }} [options]
 * @returns {IndexDocument[]}
 */
export function chunkDocument(document, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  const metadata = document.metadata || {};
  const filePath = document.file_path ?? null;
  if (metadata.chunked === true) {
    return [{ title: document.title, text: document.text, file_path: filePath, metadata }];
  }
  const headings = document.headings || [];
  const text = document.text.trim();
  const fullText = /^#\s/.test(text) ? text : `# ${document.title}\n${text}`.trim();
  const base = {
    file_path: filePath,
    metadata: { ...metadata, sourceTitle: document.title },
  };

  if (fullText.length <= maxChars) {
    return [{ title: document.title, text: fullText, ...base }];
  }

  const units = splitTextUnits(fullText, maxChars);
  const packed = packUnits(units, maxChars);
  // kotwice liczone PRZED doklejeniem overlapu: nagłówek z ogona poprzedniego chunka (overlap)
  // wskazywałby poprzednią sekcję (znalezisko przeglądu: chunk.mjs:125)
  const anchors = packed.map((text, index) => (index === 0 ? null : anchorForChunk(text, headings)));
  const textChunks = addOverlap(packed, overlapChars, maxChars);
  const chunkCount = textChunks.length;
  return textChunks.map((text, index) => {
    const anchor = anchors[index];
    return {
      title: `${document.title} - part ${index + 1}/${chunkCount}`,
      text,
      file_path: filePath,
      metadata: {
        ...base.metadata,
        source_title: document.title,
        chunk_index: index,
        chunk_count: chunkCount,
        chunked: true,
        ...(anchor ? { anchor } : {}),
      },
    };
  });
}
