// Выравнивание «текст книги <-> слова субтитров»: слово книги -> секунда аудио.
// Используем тот же поиск окна, что и для книги: он уже устойчив к пропускам и
// опечаткам распознавания, а тут нам нужны ровно те же свойства.
import { buildIndex, findWindow } from "./bookIndex.js";
import { formatTimecode } from "./vtt.js";

/** Достаёт id видео из любой формы ссылки YouTube. */
export function parseYouTubeId(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^[\w-]{11}$/.test(value)) return value;
  const patterns = [
    /(?:youtube\.com\/watch\?[^\s]*\bv=)([\w-]{11})/i,
    /(?:youtu\.be\/)([\w-]{11})/i,
    /(?:youtube\.com\/embed\/)([\w-]{11})/i,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/i,
    /(?:youtube\.com\/live\/)([\w-]{11})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return match[1];
  }
  return null;
}

/** Ссылка на конкретную секунду. */
export function youtubeUrlAt(videoId, seconds) {
  return `https://youtu.be/${videoId}?t=${Math.max(0, Math.floor(seconds))}`;
}

/**
 * Ищет в субтитрах место, соответствующее фрагменту книги.
 * @param {{ word: string, start: number, end: number }[]} subtitleWords результат vttToWords()
 * @param {string[]} bookWords нормализованные слова книги (окно страницы)
 * @param {{ minCoverage?: number }} [options]
 */
export function alignToSubtitles(subtitleWords, bookWords, options = {}) {
  if (!Array.isArray(subtitleWords) || subtitleWords.length === 0) {
    return { ok: false, reason: "нет субтитров", seconds: null, coverage: 0, confidence: "low" };
  }
  if (!Array.isArray(bookWords) || bookWords.length === 0) {
    return { ok: false, reason: "нечего искать", seconds: null, coverage: 0, confidence: "low" };
  }

  const index = buildIndex(subtitleWords.map((item) => item.word));
  const minCoverage = options.minCoverage ?? 0.35;
  const found = findWindow(index, bookWords, { maxAnchors: 30 });

  if (found.startWord < 0 || found.coverage < minCoverage) {
    return {
      ok: false,
      reason: "фрагмент не найден в субтитрах (другая озвучка или пересказ?)",
      seconds: null,
      coverage: found.coverage ?? 0,
      confidence: "low",
    };
  }

  const first = subtitleWords[found.startWord];
  const lastIndex = Math.min(subtitleWords.length - 1, found.startWord + bookWords.length - 1);
  const last = subtitleWords[lastIndex];

  return {
    ok: true,
    seconds: Math.max(0, Math.floor(first.start)),
    endSeconds: Math.max(first.start, Math.ceil(last.end)),
    timecode: formatTimecode(first.start),
    endTimecode: formatTimecode(last.end),
    coverage: found.coverage,
    exactCoverage: found.exactCoverage,
    run: found.run,
    confidence: found.confidence,
    matchedWord: first.raw,
    startWord: found.startWord,
  };
}

export default { parseYouTubeId, youtubeUrlAt, alignToSubtitles };
