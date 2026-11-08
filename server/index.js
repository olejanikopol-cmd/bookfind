// HTTP-сервер BookFind: локальный сервис «где я читал».
// Слушает 0.0.0.0, чтобы открываться с телефона в той же Wi-Fi;
// при старте печатает LAN-адрес и QR-код для быстрого открытия.
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import QRCode from "qrcode";

import { alignToSubtitles, parseYouTubeId, youtubeUrlAt } from "./align.js";
import { BookmarkStore } from "./bookmarks.js";
import { BookStore, bookId, buildBookModel, describePosition, parseBookBuffer } from "./books.js";
import { buildIndex } from "./bookIndex.js";
import { locateByImage, locateByText, wordsAround } from "./locate.js";
import { tokenize } from "./normalize.js";
import { shutdownOcr, tessdataStatus } from "./ocr.js";
import { ffmpegAvailable } from "./preprocess.js";
import { formatTimecode, vttToWords } from "./vtt.js";
import { fetchSubtitles, ytdlpAvailable } from "./ytdlp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const DEFAULT_PORT = 7788;
const MAX_BODY = "40mb";
const SUBTITLE_CACHE_TTL_MS = 10 * 60 * 1000;

function base64ToBuffer(value) {
  const clean = String(value ?? "").replace(/^data:[^,]*,/, "");
  if (!clean) throw new Error("пустые данные изображения");
  return Buffer.from(clean, "base64");
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Создаёт приложение и все зависимости. Отделено от listen(), чтобы можно было
 * тестировать HTTP-слой без занятия порта.
 */
export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? path.join(ROOT, "data");
  const booksDir = path.join(dataDir, "books");
  const tessdataDir = path.join(dataDir, "tessdata");
  const subtitleDir = path.join(dataDir, "subtitles");
  const ocrCacheDir = path.join(dataDir, "ocr-cache");

  const store = new BookStore(booksDir);
  const bookmarks = new BookmarkStore(path.join(dataDir, "bookmarks.json"));
  const ocrConfig = { tessdataDir, cachePath: ocrCacheDir };

  // Кэш разобранных субтитров в памяти: повторный запрос — без чтения диска.
  /** @type {Map<string, { words: any[], duration: number, at: number }>} */
  const subtitleCache = new Map();

  const app = express();
  app.use(express.json({ limit: MAX_BODY }));
  app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

  app.get("/api/health", asyncHandler(async (req, res) => {
    const tess = tessdataStatus(tessdataDir);
    res.json({
      ok: true,
      node: process.version,
      ffmpeg: await ffmpegAvailable(),
      ytdlp: await ytdlpAvailable(),
      tessdata: tess,
      dataDir,
      books: (await store.list()).length,
    });
  }));

  app.get("/api/books", asyncHandler(async (req, res) => {
    res.json({ books: await store.list() });
  }));

  app.post("/api/books", asyncHandler(async (req, res) => {
    const { name, dataBase64 } = req.body ?? {};
    const buffer = base64ToBuffer(dataBase64);
    const id = bookId(buffer);
    const existing = await store.load(id);
    if (existing) {
      res.json({
        id,
        cached: true,
        title: existing.book.title,
        author: existing.book.author,
        chapters: existing.book.chapters.length,
        words: existing.book.words.length,
      });
      return;
    }

    const startedAt = Date.now();
    const parsed = parseBookBuffer(name, buffer);
    const model = buildBookModel(parsed, { id });
    const index = buildIndex(model.words);
    await store.save(model, index);

    res.json({
      id,
      cached: false,
      title: model.title,
      author: model.author,
      kind: model.kind,
      chapters: model.chapters.length,
      words: model.words.length,
      ms: Date.now() - startedAt,
    });
  }));

  app.delete("/api/books/:id", asyncHandler(async (req, res) => {
    await store.remove(req.params.id);
    res.json({ ok: true });
  }));

  async function loadSubtitles(videoId, lang = "ru") {
    const key = `${videoId}:${lang}`;
    const hit = subtitleCache.get(key);
    if (hit && Date.now() - hit.at < SUBTITLE_CACHE_TTL_MS) return hit;
    const { vtt, cached } = await fetchSubtitles(videoId, { cacheDir: subtitleDir, lang });
    const parsed = vttToWords(vtt);
    const entry = { ...parsed, cached, at: Date.now() };
    subtitleCache.set(key, entry);
    return entry;
  }

  app.post("/api/locate", asyncHandler(async (req, res) => {
    const { bookId: id, imageBase64, text } = req.body ?? {};
    const entry = await store.load(String(id ?? ""));
    if (!entry) {
      res.status(404).json({ error: "книга не найдена — сначала загрузите её в библиотеку" });
      return;
    }
    const { book, index } = entry;
    const startedAt = Date.now();

    let result;
    if (imageBase64) {
      result = await locateByImage(book, index, base64ToBuffer(imageBase64), ocrConfig);
    } else if (typeof text === "string" && text.trim().length > 0) {
      result = locateByText(book, index, text);
    } else {
      res.status(400).json({ error: "нужен imageBase64 или text" });
      return;
    }

    res.json({
      book: { id: book.id, title: book.title, author: book.author },
      ...result,
      ms: Date.now() - startedAt,
    });
  }));

  app.post("/api/audio/link", asyncHandler(async (req, res) => {
    const { bookId: id, youtubeUrl, wordPosition, lang } = req.body ?? {};
    const videoId = parseYouTubeId(youtubeUrl);
    if (!videoId) {
      res.status(400).json({ error: "не удалось разобрать ссылку YouTube" });
      return;
    }

    const entry = id ? await store.load(String(id)) : null;
    let queryWords = [];
    let positionInfo = null;

    if (entry && Number.isFinite(Number(wordPosition))) {
      const from = Math.max(0, Number(wordPosition));
      queryWords = wordsAround(entry.book, from, 18);
      positionInfo = describePosition(entry.book, from);
    } else if (req.body?.text) {
      queryWords = tokenize(String(req.body.text)).words;
    }

    if (queryWords.length === 0) {
      res.status(400).json({ error: "нужен wordPosition (или text), чтобы найти место в аудио" });
      return;
    }

    const startedAt = Date.now();
    const subtitles = await loadSubtitles(videoId, lang || "ru");
    const aligned = alignToSubtitles(subtitles.words, queryWords);

    const url = aligned.ok ? youtubeUrlAt(videoId, aligned.seconds) : "";
    const qr = url ? await QRCode.toDataURL(url, { margin: 1, width: 260 }) : "";

    res.json({
      book: positionInfo,
      videoId,
      subtitleWords: subtitles.words.length,
      subtitleDuration: formatTimecode(subtitles.duration),
      subtitlesCached: Boolean(subtitles.cached),
      ...aligned,
      url,
      qr,
      ms: Date.now() - startedAt,
    });
  }));

  app.get("/api/subtitles/:videoId", asyncHandler(async (req, res) => {
    const videoId = parseYouTubeId(req.params.videoId);
    if (!videoId) {
      res.status(400).json({ error: "некорректный id видео" });
      return;
    }
    const subtitles = await loadSubtitles(videoId, req.query.lang ? String(req.query.lang) : "ru");
    res.json({
      videoId,
      words: subtitles.words.length,
      duration: formatTimecode(subtitles.duration),
      cached: Boolean(subtitles.cached),
      sample: subtitles.words.slice(0, 20).map((word) => `${word.word}@${word.start.toFixed(2)}`),
    });
  }));

  app.get("/api/bookmarks", asyncHandler(async (req, res) => {
    res.json({ bookmarks: await bookmarks.list(req.query.bookId ? String(req.query.bookId) : undefined) });
  }));

  app.post("/api/bookmarks", asyncHandler(async (req, res) => {
    res.json({ bookmark: await bookmarks.add(req.body ?? {}) });
  }));

  app.delete("/api/bookmarks/:id", asyncHandler(async (req, res) => {
    res.json({ ok: await bookmarks.remove(req.params.id) });
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error("[http]", req.method, req.path, "-", error?.message ?? error);
    res.status(400).json({ error: error?.message ?? "внутренняя ошибка" });
  });

  return { app, store, bookmarks, ocrConfig, subtitleCache, paths: { dataDir, booksDir, tessdataDir, subtitleDir, ocrCacheDir } };
}

/** Все не-loopback IPv4-адреса машины — чтобы открыть сервис с телефона. */
export function lanAddresses() {
  const result = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) result.push({ name, address: info.address });
    }
  }
  return result;
}

/** Запускает сервер и печатает адреса + QR для открытия с телефона. */
export async function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const ctx = await createApp(options);
  const server = await new Promise((resolve, reject) => {
    const instance = ctx.app.listen(port, "0.0.0.0", () => resolve(instance));
    instance.on("error", reject);
  });

  const actualPort = server.address().port;
  const localUrl = `http://localhost:${actualPort}`;
  const lan = lanAddresses();

  console.log(`\n  BookFind запущен: ${localUrl}`);
  for (const item of lan) console.log(`  с телефона:       http://${item.address}:${actualPort}  (${item.name})`);
  if (lan.length > 0) {
    const qr = await QRCode.toString(`http://${lan[0].address}:${actualPort}`, { type: "terminal", small: true });
    console.log(qr);
  }
  console.log(`  данные: ${ctx.paths.dataDir}\n`);

  const shutdown = () => {
    console.log("\n  останавливаю BookFind…");
    server.close();
    shutdownOcr().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { server, ctx, port: actualPort, localUrl, lan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  startServer({ port }).catch((error) => {
    console.error("не удалось запустить BookFind:", error);
    process.exit(1);
  });
}
