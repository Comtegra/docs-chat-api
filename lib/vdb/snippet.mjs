// @ts-check
// Snippet fragmentu RAG do kart źródeł (Context Cards) — plan docs/ai-native-ui-plan.md §4.2.
// JEDYNE miejsce, w którym z `properties.text` chunka powstaje tekst dla UI: używane przez
// buildSources() (ramka `sources` serwisu). Wynik jest
// CZYSTYM TEKSTEM — karta renderuje go jako tekst, nigdy jako markdown.
//
// Co jest w chunkach (cgc-user-docs/python/md_to_json.py): "# <tytuł>\n" + surowy markdown/MDX
// (frontmatter i komentarze zdjęte). Zostają: `import … from '@theme/…'`, tagi JSX/HTML
// (<Tabs>, <video>), admonitions `:::tip`, fence'y kodu, linki, obrazki, tabele.
// Chunki > 8000 znaków są dzielone z 300-znakowym overlapem = ogon poprzedniego chunka.
// UWAGA na dwa kształty overlapu w bazie: stary ingest skleja ogon z treścią BEZ separatora
// ("…koniec zdania.## Nagłówek\n\n…" — nawet "…\n```## Nagłówek", gdy poprzedni chunk kończył
// się fence'em), nowy (E1-docs) rozdziela pustą linią. Obsługujemy oba: doklejamy "\n" przed
// sklejonym nagłówkiem, a gołe ``` na początku okna traktujemy jako domknięcie fence'a
// otwartego w poprzednim chunku.

const OVERLAP_CHARS = 300;
const DEFAULT_MAX = 240;
// snippet ma ≤ 240 znaków — dalsze 6000 wystarcza z zapasem, a ogranicza koszt regexów
// (kwadratowe na patologicznych wejściach: 8k backticków ≈ 50 ms, 32k ≈ 700 ms)
const MAX_INPUT_CHARS = 6000;

// tagi, które NAPRAWDĘ występują w korpusie docs jako markup (JSX/HTML). Wszystko inne
// w <nawiasach> to placeholdery CLI (`<volume_name>`, `<gpu_type>`) i porównania w prozie —
// mają zostać.
const KNOWN_TAGS =
  "Tabs|TabItem|details|summary|div|span|video|source|img|br|p|a|g|svg|rect|path|polygon|clipPath|circle|table|thead|tbody|tr|td|th|ul|ol|li|code|pre|em|strong|b|i|sup|sub|iframe|kbd";
const TAG_PATTERN = new RegExp(
  // zamykający </X>, samozamykający <X …/>, z atrybutami <X attr…>, goły <X> ze znanej listy
  `<\\/[A-Za-z][\\w-]*\\s*>|<[A-Za-z][\\w-]*(?:\\s+[^<>]*)?\\/>|<[A-Za-z][\\w-]*\\s+[^<>]*>|<(?:${KNOWN_TAGS})\\s*>`,
  "g"
);

/**
 * @param {string} text
 * @returns {string}
 */
function stripMarkup(text) {
  // 1) fence'y kodu — całe bloki (snippet to podgląd prozy; polecenia są w odpowiedzi);
  //    PRZED ochroną code spanów, bo regex spanów pociąłby ``` na pary
  let body = text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, " ")
    // niedomknięty fence na końcu chunka (ucięty przez chunking)
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/m, " ");

  // 2) code spans do sejfu (sentinel z Private Use Area — nie występuje w treści docs):
  //    placeholdery `<name>` w inline code nie mogą zniknąć razem z tagami
  /** @type {string[]} */
  const spans = [];
  body = body.replace(/`([^`\n]*)`/g, (_m, inner) => {
    spans.push(inner);
    return `\uE000${spans.length - 1}\uE001`;
  });

  body = body
    // MDX: import/export TYLKO jako składnia modułu (nie proza zaczynająca się od "export the…")
    .replace(/^[ \t]*import\s+[\w{*].*?\sfrom\s+['"][^'"]+['"];?[ \t]*$/gm, " ")
    .replace(/^[ \t]*export\s+(?:const|default|function|class)\b[^\n]*$/gm, " ")
    // definicje referencji linków: `[1]: http://…`
    .replace(/^[ \t]*\[[^\]]+\]:[ \t]+\S+[^\n]*$/gm, " ")
    // admonitions: `:::tip Tytuł` i zamykające `:::`
    .replace(/^[ \t]*:::[^\n]*$/gm, " ")
    // obrazki: ![alt](src) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // linki: [tekst](url) → tekst; referencyjne [tekst][id] → tekst
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    // realne tagi JSX/HTML (patrz TAG_PATTERN) — treść między nimi zostaje
    .replace(TAG_PATTERN, " ")
    // nagłówki: marker → tekst nagłówka + ": " (żeby nie zlewał się z akapitem)
    .replace(/^[ \t]*#{1,6}[ \t]+([^\n]*?)[ \t]*#*[ \t]*$/gm, "$1: ")
    // separatory tabel i wiersze-linie
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, " ")
    .replace(/\|/g, " ")
    // pogrubienie/kursywa — zostaje tekst
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    // listy i cytaty: markery
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    // poziome linie
    .replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, " ");

  // 3) code spans z powrotem, jako tekst
  return body.replace(/\uE000(\d+)\uE001/g, (_m, i) => spans[Number(i)] ?? "");
}

/**
 * Obcina do `max` znaków: najpierw na granicy zdania (jeśli jest po 60 % długości — wtedy bez
 * „…", bo zdanie jest kompletne), inaczej na granicy słowa z „…".
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd >= max * 0.6) {
    return head.slice(0, sentenceEnd + 1);
  }
  const wordEnd = head.lastIndexOf(" ");
  return `${(wordEnd > max * 0.5 ? head.slice(0, wordEnd) : head).trimEnd()}…`;
}

/**
 * Dla chunka ≥ 2: pierwsze ~300 znaków to ogon poprzedniego chunka. Startujemy od
 * pierwszego nagłówka w tym oknie; jeśli okno zaczyna się gołym ``` (domknięcie fence'a
 * z poprzedniego chunka), tniemy do niego; bez nagłówka — od pierwszego końca zdania.
 * @param {string} body
 */
function skipOverlapTail(body) {
  const windowEnd = OVERLAP_CHARS + 16;
  const window = body.slice(0, windowEnd);
  const heading = /(^|\n)#{1,6}[ \t]+\S/.exec(window);
  if (heading) {
    return body.slice(heading.index === 0 ? 0 : heading.index + 1);
  }
  const bareFence = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(\n|$)/.exec(window);
  if (bareFence && !/^\s*(`{3,}|~{3,})\S/m.test(window.slice(0, bareFence.index))) {
    return body.slice(bareFence.index + bareFence[0].length);
  }
  const sentence = /[.!?][ \n]/.exec(window);
  return sentence ? body.slice(sentence.index + 1) : body;
}

/**
 * @param {unknown} text            `properties.text` chunka
 * @param {number} [max=240]         maksymalna długość snippetu (znaki)
 * @param {{ chunkIndex?: number }} [options]  `properties.metadata.chunk_index` (tylko chunkowane dokumenty)
 * @returns {string} czysty tekst ("" gdy nic nie zostało)
 */
export function toSnippet(text, max = DEFAULT_MAX, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }
  let body = text
    .slice(0, MAX_INPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    // stary ingest sklejał ogon overlapu z nagłówkiem bez separatora: "…koniec.## Nagłówek"
    .replace(/([^\n#])(#{2,6}[ \t]+\S)/g, "$1\n$2");

  const chunkIndex = Number(options.chunkIndex);
  if (Number.isInteger(chunkIndex) && chunkIndex > 0) {
    body = skipOverlapTail(body);
  }

  // pierwsza linia = "# <tytuł>" (duplikat title) — pomijamy
  body = body.replace(/^\s*#[ \t]+[^\n]*\n?/, "");

  const plain = stripMarkup(body).replace(/\s+/g, " ").trim();
  if (!plain) {
    return "";
  }
  return truncate(plain, Math.max(16, Number(max) || DEFAULT_MAX));
}
