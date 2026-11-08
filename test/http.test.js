import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createApp } from "../server/index.js";

// Отдельная «книга» на каждый абзац, чтобы позицию можно было проверить.
const SYLLABLES = ["ка", "ро", "ми", "ту", "не", "ва", "лу", "си", "до", "пе", "за", "гу", "бы", "чи", "хо", "же"];
const bookText = Array.from({ length: 24 }, (_, p) => {
  const marker = [0, 1, 2]
    .map((k) => SYLLABLES[(p * (k + 3) + k * 5) % SYLLABLES.length])
    .join("") + `${p}`;
  return `Глава ${p}. ${marker} открывает описание сцены, где герой пересёк широкую реку и увидел караван.`;
}).join("\n\n");

let server;
let base;
let dataDir;
let bookId;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "bookfind-http-"));
  const ctx = await createApp({ dataDir });
  server = ctx.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // fetch (undici) держит keep-alive соединения — без этого close() не завершится.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

async function call(method, pathname, body) {
  const response = await fetch(base + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

test("GET /api/health отвечает и знает про окружение", async () => {
  const { status, data } = await call("GET", "/api/health");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(typeof data.ffmpeg, "boolean");
  assert.equal(typeof data.ytdlp, "boolean");
  assert.equal(data.books, 0);
});

test("статика отдаётся с корня", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("BookFind"));
});

test("загрузка книги, повторная загрузка из кэша и список", async () => {
  const dataBase64 = Buffer.from(bookText, "utf8").toString("base64");
  const created = await call("POST", "/api/books", { name: "test.txt", dataBase64 });
  assert.equal(created.status, 200);
  assert.equal(created.data.cached, false);
  assert.ok(created.data.words > 100);
  bookId = created.data.id;

  const again = await call("POST", "/api/books", { name: "test.txt", dataBase64 });
  assert.equal(again.data.cached, true);
  assert.equal(again.data.id, bookId);

  const list = await call("GET", "/api/books");
  assert.equal(list.data.books.length, 1);
});

test("POST /api/locate находит фрагмент текста", async () => {
  const words = bookText.split("\n\n");
  const fragment = words[17];
  const { status, data } = await call("POST", "/api/locate", { bookId, text: fragment });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.coverage > 0.9, `покрытие низкое: ${data.coverage}`);
  assert.equal(data.percent > 65 && data.percent < 80, true, `процент ${data.percent}`);
  assert.ok(data.quote.length > 20);
  assert.equal(typeof data.wordPosition, "number");
  assert.equal(typeof data.ms, "number");
});

test("POST /api/locate ругается на неизвестную книгу и пустой запрос", async () => {
  const missing = await call("POST", "/api/locate", { bookId: "нет-такой", text: "какой-то текст страницы" });
  assert.equal(missing.status, 404);

  const empty = await call("POST", "/api/locate", { bookId });
  assert.equal(empty.status, 400);
});

test("POST /api/audio/link проверяет вход без обращения к сети", async () => {
  const badUrl = await call("POST", "/api/audio/link", { bookId, youtubeUrl: "не ссылка" });
  assert.equal(badUrl.status, 400);

  const noPosition = await call("POST", "/api/audio/link", { bookId, youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(noPosition.status, 400);
  assert.match(noPosition.data.error, /wordPosition/);
});

test("GET /api/subtitles отвечает 400 на битый id", async () => {
  const { status } = await call("GET", "/api/subtitles/!!!");
  assert.equal(status, 400);
});

test("закладки: добавить, прочитать, удалить", async () => {
  const added = await call("POST", "/api/bookmarks", {
    bookId,
    title: "Тестовая книга",
    chapterTitle: "Глава 17",
    percent: 71.5,
    pageEstimate: 210,
    quote: "герой пересёк широкую реку",
    youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
  });
  assert.equal(added.status, 200);
  const id = added.data.bookmark.id;
  assert.ok(id);

  const list = await call("GET", `/api/bookmarks?bookId=${bookId}`);
  assert.equal(list.data.bookmarks.length, 1);
  assert.equal(list.data.bookmarks[0].chapterTitle, "Глава 17");

  const removed = await call("DELETE", `/api/bookmarks/${id}`);
  assert.equal(removed.data.ok, true);
  const empty = await call("GET", "/api/bookmarks");
  assert.equal(empty.data.bookmarks.length, 0);
});

test("DELETE /api/books убирает книгу из библиотеки", async () => {
  const removed = await call("DELETE", `/api/books/${bookId}`);
  assert.equal(removed.data.ok, true);
  const list = await call("GET", "/api/books");
  assert.equal(list.data.books.length, 0);
});
