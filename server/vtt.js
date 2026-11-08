// WebVTT -> слова с таймкодами.
//
// YouTube-автосубтитры приходят в roll-up виде: каждая реплика повторяет
// предыдущую строку (без таймкодов) и добавляет новую строку с инлайн-таймкодами
// (<00:00:07.049><c>иван</c>). Поэтому строки без таймкодов внутри такой реплики —
// это уже произнесённый контекст, их надо игнорировать, иначе каждое слово
// попадёт в поток 2-3 раза и таймкод «поедет».
import { normalize } from "./normalize.js";

const TIMECODE = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const TIMESTAMP_LINE_RE = new RegExp(String.raw`^\s*(${TIMECODE})\s*-->\s*(${TIMECODE})`, "i");
const INLINE_TAG_RE = new RegExp(String.raw`<(${TIMECODE})>|<[^>]*>`, "g");

/** "00:01:23.450" -> секунды. */
export function parseTimestamp(value) {
  const parts = String(value).trim().replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number.isFinite(parts[0]) ? parts[0] : 0;
}

/** Секунды -> "2:14:37" (часы опускаются, если нулевые). */
export function formatTimecode(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Разбирает VTT в массив реплик. */
export function parseVtt(input) {
  const text = String(input).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIdx = lines.findIndex((line) => TIMESTAMP_LINE_RE.test(line));
    if (timingIdx === -1) continue;
    const match = TIMESTAMP_LINE_RE.exec(lines[timingIdx]);
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    const body = lines.slice(timingIdx + 1).join("\n");
    cues.push({ start, end, text: body });
  }
  return cues;
}

function stripTags(line) {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Строка с инлайн-таймкодами -> слова с индивидуальными временами.
function splitTimedLine(line, startTime) {
  const words = [];
  let time = startTime;
  let cursor = 0;
  let match = INLINE_TAG_RE.exec(line);
  const pushChunk = (chunk) => {
    for (const raw of stripTags(chunk).split(/\s+/)) {
      if (raw) words.push({ raw, start: time });
    }
  };
  while (match) {
    pushChunk(line.slice(cursor, match.index));
    if (match[1]) time = parseTimestamp(match[1]);
    cursor = INLINE_TAG_RE.lastIndex;
    match = INLINE_TAG_RE.exec(line);
  }
  pushChunk(line.slice(cursor));
  return words;
}

/**
 * VTT -> массив слов { raw, word, start, end }.
 * end слова = start следующего слова, для последнего — конец реплики.
 */
export function vttToWords(input) {
  const cues = typeof input === "string" ? parseVtt(input) : input;
  /** @type {{ raw: string, word: string, start: number }[]} */
  const collected = [];

  for (const cue of cues) {
    // YouTube вставляет технические реплики длиной 10 мс — они подтверждают
    // предыдущий текст и не несут новых слов.
    if (cue.end - cue.start < 0.1) continue;

    const lines = cue.text.split("\n").filter((line) => line.trim().length > 0);
    const timed = lines.filter((line) => /<\d{1,2}:\d{2}(:\d{2})?(?:[.,]\d{1,3})?>/.test(line));

    if (timed.length > 0) {
      // roll-up: берём только строки с таймкодами (новые слова)
      for (const line of timed) {
        for (const item of splitTimedLine(line, cue.start)) collected.push(item);
      }
    } else {
      // обычные субтитры: текст реплики целиком, время растягиваем по словам.
      // Отрезаем перекрытие с уже собранным потоком — roll-up дублирует контекст.
      const plainWords = stripTags(lines.join(" "))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (plainWords.length === 0) continue;

      const normalizedNew = plainWords.map((raw) => normalize(raw).trim());
      const limit = Math.min(plainWords.length, collected.length, 24);
      let overlap = 0;
      for (let k = limit; k > 0; k -= 1) {
        let same = true;
        for (let i = 0; i < k; i += 1) {
          if (normalize(collected[collected.length - k + i].raw).trim() !== normalizedNew[i]) {
            same = false;
            break;
          }
        }
        if (same) {
          overlap = k;
          break;
        }
      }
      const fresh = plainWords.slice(overlap);
      if (fresh.length === 0) continue;

      const span = Math.max(0.05, cue.end - cue.start);
      fresh.forEach((raw, index) => {
        collected.push({ raw, start: cue.start + (span * index) / fresh.length });
      });
    }
  }

  const words = [];
  for (let i = 0; i < collected.length; i += 1) {
    const item = collected[i];
    const word = normalize(item.raw).trim();
    if (!word) continue;
    const next = collected[i + 1];
    const end = next ? Math.max(item.start, next.start) : item.start + 0.4;
    words.push({ raw: item.raw, word, start: item.start, end });
  }

  return { words, duration: words.length > 0 ? words[words.length - 1].end : 0 };
}

export default { parseVtt, vttToWords, parseTimestamp, formatTimecode };
