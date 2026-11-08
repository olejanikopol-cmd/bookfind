// Оркестрация поиска: фото или текст страницы -> место в книге.
// Отдельный модуль, чтобы HTTP-слой остался тонким, а логику можно было тестировать.
import { findWindow } from "./bookIndex.js";
import { describePosition, quoteFor } from "./books.js";
import { tokenize } from "./normalize.js";
import { recognizeImage } from "./ocr.js";
import { preprocessImage } from "./preprocess.js";

// Больше 140 слов запроса не нужно: страница целиком, а выравнивание становится
// только дороже (DP растёт как произведение длин).
export const MAX_QUERY_WORDS = 140;
const MIN_QUERY_WORDS = 4;

/**
 * Ищет место в книге по тексту страницы.
 * @param {any} book модель книги (buildBookModel)
 * @param {any} index пословный индекс
 * @param {string} text распознанный или вставленный текст
 */
export function locateByText(book, index, text) {
  const startedAt = Date.now();
  const { words } = tokenize(text ?? "");
  if (words.length < MIN_QUERY_WORDS) {
    return {
      ok: false,
      reason: `слишком мало текста: ${words.length} слов, нужно минимум ${MIN_QUERY_WORDS}`,
      coverage: 0,
      confidence: "low",
    };
  }

  const query = words.length > MAX_QUERY_WORDS ? words.slice(0, MAX_QUERY_WORDS) : words;
  const found = findWindow(index, query, { minCoverage: 0.2 });
  const searchMs = Date.now() - startedAt;

  if (found.startWord < 0) {
    return {
      ok: false,
      reason: "фрагмент не найден в этой книге",
      coverage: found.coverage ?? 0,
      confidence: "low",
      searchMs,
      queryWords: query.length,
    };
  }

  const position = describePosition(book, found.startWord, found.endWord);
  const quotes = quoteFor(book, found.startWord);

  return {
    ok: true,
    ...position,
    ...quotes,
    coverage: found.coverage,
    exactCoverage: found.exactCoverage,
    run: found.run,
    confidence: found.confidence,
    queryWords: query.length,
    searchMs,
  };
}

/**
 * Фото/скриншот -> текст (OCR) -> место в книге.
 * @param {any} book
 * @param {any} index
 * @param {Buffer} imageBuffer
 * @param {{ tessdataDir: string, cachePath: string, logger?: (m: any) => void }} ocrConfig
 */
export async function locateByImage(book, index, imageBuffer, ocrConfig) {
  const startedAt = Date.now();
  const prepared = await preprocessImage(imageBuffer, { enhance: true });
  const ocr = await recognizeImage(prepared, ocrConfig);
  const ocrMs = Date.now() - startedAt;

  const located = locateByText(book, index, ocr.text);
  return {
    ...located,
    ocr: {
      confidence: ocr.confidence,
      lines: ocr.lines,
      keptLines: ocr.keptLines,
      characters: ocr.text.length,
      ms: ocrMs,
      text: ocr.text.slice(0, 600),
    },
    totalMs: Date.now() - startedAt,
  };
}

/** Нормализованные слова книги вокруг позиции — запрос для выравнивания с субтитрами. */
export function wordsAround(book, wordPosition, count = 18) {
  const total = book.words.length;
  if (total === 0) return [];
  const from = Math.max(0, Math.min(wordPosition, total - 1));
  const to = Math.min(total, from + count);
  return book.words.slice(from, to);
}

export default { locateByText, locateByImage, wordsAround };
