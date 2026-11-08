// Модель книги: единый текст + пословные смещения + границы глав.
// Хранится на диске в data/books/<sha1>/, индекс кэшируется через v8.serialize
// (Map сериализуется нативно — повторная загрузка без пересборки).
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import v8 from "node:v8";

import { buildIndex } from "./bookIndex.js";
import { parseEpub } from "./epub.js";
import { parseFb2, parseTxt } from "./fb2.js";
import { tokenize } from "./normalize.js";

export const DEFAULT_WORDS_PER_PAGE = 300;

/**
 * Заголовок главы: если в файле названия нет (или оно автогенерированное),
 * показываем начало текста — «Часть 53» пользователю ничего не говорит.
 */
function chapterTitleOf(rawTitle, text) {
  const title = (rawTitle || "").replace(/\s+/g, " ").trim();
  if (title && !/^Часть \d+$/.test(title)) return title;
  const preview = text.replace(/\s+/g, " ").trim();
  if (!preview) return title || "Без названия";
  if (preview.length <= 60) return preview;
  const cut = preview.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 20 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Собирает главы в единый текст и запоминает границы глав в словах.
 * @param {{ title: string, author: string, kind?: string, chapters: {title: string, text: string}[] }} parsed
 * @param {{ id?: string, wordsPerPage?: number }} [meta]
 */
export function buildBookModel(parsed, meta = {}) {
  const wordsPerPage = meta.wordsPerPage ?? DEFAULT_WORDS_PER_PAGE;
  const words = [];
  const starts = [];
  const ends = [];
  const chapters = [];
  let text = "";

  for (const chapter of parsed.chapters) {
    const base = text.length;
    const { words: chapterWords, starts: chapterStarts, ends: chapterEnds } = tokenize(chapter.text);
    const startWord = words.length;
    for (let i = 0; i < chapterWords.length; i += 1) {
      words.push(chapterWords[i]);
      starts.push(base + chapterStarts[i]);
      ends.push(base + chapterEnds[i]);
    }
    text += `${chapter.text}\n\n`;
    if (chapterWords.length > 0) {
      chapters.push({
        index: chapters.length,
        title: chapterTitleOf(chapter.title, chapter.text),
        startWord,
        endWord: words.length - 1,
      });
    }
  }

  return {
    id: meta.id ?? "",
    title: parsed.title || "Без названия",
    author: parsed.author || "",
    kind: parsed.kind ?? "unknown",
    wordsPerPage,
    text,
    words,
    starts,
    ends,
    chapters,
  };
}

/** Позиция слова -> глава, процент, оценка страницы. */
export function describePosition(book, startWord, endWord = startWord) {
  const total = book.words.length;
  const clamped = Math.max(0, Math.min(startWord, total - 1));
  const percent = total > 0 ? (clamped / total) * 100 : 0;

  let chapter = book.chapters[book.chapters.length - 1] ?? { index: 0, title: "—", startWord: 0, endWord: total - 1 };
  for (const candidate of book.chapters) {
    if (clamped >= candidate.startWord && clamped <= candidate.endWord) {
      chapter = candidate;
      break;
    }
    if (clamped < candidate.startWord) break;
  }

  const pageEstimate = Math.max(1, Math.round(clamped / book.wordsPerPage) + 1);
  const totalPages = Math.max(1, Math.ceil(total / book.wordsPerPage));

  return {
    chapterIndex: chapter.index,
    chapterTitle: chapter.title,
    chapterCount: book.chapters.length,
    percent: Math.round(percent * 10) / 10,
    pageEstimate,
    totalPages,
    wordPosition: clamped,
    wordEnd: Math.min(endWord, total - 1),
    totalWords: total,
  };
}

/** Вырезает цитату из исходного (ненормализованного) текста по номерам слов. */
export function quoteFor(book, startWord, wordsCount = 14) {
  const total = book.words.length;
  if (total === 0) return { quote: "", quoteTail: "" };
  const from = Math.max(0, Math.min(startWord, total - 1));
  const to = Math.min(total - 1, from + wordsCount - 1);
  const quote = book.text.slice(book.starts[from], book.ends[to]).replace(/\s+/g, " ").trim();

  const tailFrom = Math.max(0, to - 7);
  const quoteTail = book.text.slice(book.starts[tailFrom], book.ends[to]).replace(/\s+/g, " ").trim();

  return { quote, quoteTail };
}

/** Определяет формат по сигнатуре и имени файла. */
export function parseBookBuffer(name, buffer) {
  if (buffer.length < 4) throw new Error("файл пустой или слишком маленький");
  const signature = buffer.subarray(0, 4).toString("latin1");
  if (signature.startsWith("PK")) return parseEpub(buffer);
  const head = buffer.subarray(0, 4096).toString("latin1");
  if (/<FictionBook/i.test(head) || /\.fb2(\.txt)?$/i.test(name || "")) return parseFb2(buffer);
  return parseTxt(buffer);
}

export function bookId(buffer) {
  return createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

/** Хранилище книг: book.json + index.bin (v8.serialize) в data/books/<id>/ */
export class BookStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    /** @type {Map<string, { book: any, index: any }>} */
    this.cache = new Map();
  }

  dirFor(id) {
    return path.join(this.rootDir, id);
  }

  /** Сохраняет разобранную книгу и построенный индекс. */
  async save(book, index) {
    const dir = this.dirFor(book.id);
    await mkdir(dir, { recursive: true });
    const meta = {
      id: book.id,
      title: book.title,
      author: book.author,
      kind: book.kind,
      wordsPerPage: book.wordsPerPage,
      text: book.text,
      chapters: book.chapters,
    };
    await writeFile(path.join(dir, "book.json"), JSON.stringify(meta));
    const payload = v8.serialize({
      words: index.words,
      positions: index.positions,
      deletions: index.deletions,
      size: index.size,
    });
    await writeFile(path.join(dir, "index.bin"), payload);
    this.cache.set(book.id, { book, index });
    return book;
  }

  /** Загружает книгу и индекс (из кэша в памяти, с диска или пересобирает). */
  async load(id) {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const dir = this.dirFor(id);
    const raw = await readFile(path.join(dir, "book.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    const meta = JSON.parse(raw);

    let index = null;
    const indexRaw = await readFile(path.join(dir, "index.bin")).catch(() => null);
    if (indexRaw) {
      try {
        const data = v8.deserialize(indexRaw);
        if (data && data.size === data.words.length && data.words.length > 0) index = data;
      } catch {
        index = null; // кэш от другой версии node — просто пересоберём
      }
    }

    const { words, starts, ends } = tokenize(meta.text);
    const book = { ...meta, words, starts, ends };
    if (!index) {
      index = buildIndex(words);
      await writeFile(path.join(dir, "index.bin"), v8.serialize({
        words: index.words,
        positions: index.positions,
        deletions: index.deletions,
        size: index.size,
      })).catch(() => {});
    }

    const entry = { book, index };
    this.cache.set(id, entry);
    return entry;
  }

  /** Список книг библиотеки (без текста). */
  async list() {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const books = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const raw = await readFile(path.join(this.rootDir, entry.name, "book.json"), "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const meta = JSON.parse(raw);
        const info = await stat(path.join(this.rootDir, entry.name, "book.json")).catch(() => null);
        books.push({
          id: meta.id,
          title: meta.title,
          author: meta.author,
          kind: meta.kind,
          chapters: meta.chapters.length,
          words: meta.chapters.length > 0 ? meta.chapters[meta.chapters.length - 1].endWord + 1 : 0,
          addedAt: info ? info.mtime.toISOString() : null,
        });
      } catch {
        /* битый book.json пропускаем */
      }
    }
    books.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    return books;
  }

  /** Удаляет книгу из библиотеки. */
  async remove(id) {
    if (!/^[0-9a-f]{4,64}$/.test(id)) throw new Error("некорректный id книги");
    this.cache.delete(id);
    await rm(this.dirFor(id), { recursive: true, force: true });
  }
}
