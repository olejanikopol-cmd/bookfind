// Нормализация текста для поиска.
//
// Ключевое свойство: normalize() ПОСИМВОЛЬНО переписывает строку, поэтому длина
// результата всегда равна длине входа. Благодаря этому смещения слов, найденные
// в нормализованной строке, напрямую применимы к исходному тексту — так мы потом
// вырезаем цитату «как в книге», а не «как после нормализации».
//
// Что делаем:
//  - NFKC, но по одному символу (целиковая NFKC меняет длину строки);
//  - lower case, ё -> е;
//  - всё, что не буква и не цифра (пунктуация, тире, дефисы, кавычки) -> пробел;
//  - схлопываем визуальные гомоглифы латиница -> кириллица.
//
// Фолдинг гомоглифов — не украшение: OCR регулярно читает кириллическую «с» как
// латинскую «c», и без фолдинга такие слова не находятся вообще (0% точности).

const ASCII_FOLD = new Map(
  Object.entries({
    a: "а",
    b: "в",
    c: "с",
    e: "е",
    h: "н",
    k: "к",
    m: "м",
    o: "о",
    p: "р",
    t: "т",
    x: "х",
    y: "у",
  }),
);

const SPACE = 0x20;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const charCache = new Map();

// Приводим один символ к нормализованному виду. Возвращаем ровно один символ.
function foldChar(ch) {
  const code = ch.charCodeAt(0);

  // Быстрый путь для ASCII: так обрабатывается 100% английского текста
  // и вся пунктуация любого текста.
  if (code < 0x80) {
    if (code >= 0x61 && code <= 0x7a) {
      return ASCII_FOLD.get(ch) ?? ch;
    }
    if (code >= 0x41 && code <= 0x5a) {
      const lower = ch.toLowerCase();
      return ASCII_FOLD.get(lower) ?? lower;
    }
    if (code >= 0x30 && code <= 0x39) return ch;
    return " ";
  }

  const cached = charCache.get(ch);
  if (cached !== undefined) return cached;

  let folded = " ";
  const nfkc = ch.normalize("NFKC");
  if (nfkc.length > 0) {
    // lower() может дать несколько кодовых точек (например, İ), берём первую.
    const lower = nfkc.toLowerCase();
    const first = lower.codePointAt(0);
    if (first !== undefined && LETTER_OR_DIGIT.test(String.fromCodePoint(first))) {
      let candidate = String.fromCodePoint(first);
      if (candidate === "ё" || candidate === "Ё") candidate = "е";
      folded = candidate;
    }
  }

  charCache.set(ch, folded);
  return folded;
}

/**
 * Нормализует произвольный текст, сохраняя длину и позиции символов.
 * @param {string} text
 * @returns {string} строка той же длины, где всё лишнее заменено на пробелы
 */
export function normalize(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const out = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = foldChar(text[i]);
  }
  return out.join("");
}

/**
 * Режет текст на слова с координатами в ИСХОДНОЙ строке.
 * @param {string} text
 * @returns {{ words: string[], starts: number[], ends: number[] }}
 */
export function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { words: [], starts: [], ends: [] };
  }
  const normalized = normalize(text);
  const words = [];
  const starts = [];
  const ends = [];
  const { length } = normalized;

  let i = 0;
  while (i < length) {
    while (i < length && normalized.charCodeAt(i) === SPACE) i += 1;
    const start = i;
    while (i < length && normalized.charCodeAt(i) !== SPACE) i += 1;
    if (i > start) {
      words.push(normalized.slice(start, i));
      starts.push(start);
      ends.push(i);
    }
  }

  return { words, starts, ends };
}

/** Удобный шорткат: текст -> массив нормализованных слов. */
export function tokenizeWords(text) {
  return tokenize(text).words;
}

/**
 * Расстояние Левенштейна с ранним выходом (нужно только «<= 1 или нет»).
 * Для одинаковых по длине слов достаточно сравнения символов.
 */
export function editDistanceAtMost(a, b, limit = 1) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > limit) return limit + 1;

  let prevPrev = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;

  for (let i = 1; i <= la; i += 1) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1); // транспозиция
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    prevPrev = prev;
    prev = curr;
  }
  return prev[lb];
}

export default { normalize, tokenize, tokenizeWords, editDistanceAtMost };
