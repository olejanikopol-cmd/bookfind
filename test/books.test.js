import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildIndex } from "../server/bookIndex.js";
import { BookStore, bookId, buildBookModel, describePosition, parseBookBuffer, quoteFor } from "../server/books.js";
import { locateByText, wordsAround } from "../server/locate.js";

/**
 * Собирает минимальный ZIP без сжатия (stored) — ровно то, что умеет читать
 * server/epub.js. Нужен, чтобы тест EPUB не зависел от файлов на диске.
 */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuffer = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const CHAPTER_ONE =
  "Глава первая. Дорога. Странник шёл на восток, где за холмами начиналась пустыня и где ветер нёс песок.";
const CHAPTER_TWO =
  "Глава вторая. Встреча. Караван торговцев пряностями остановился на ночлег у высохшего колодца.";

const EPUB_BUFFER = makeZip({
  "META-INF/container.xml":
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "OEBPS/content.opf":
    '<?xml version="1.0"?><package><metadata><dc:title>Тестовая книга</dc:title><dc:creator>Иван Тестов</dc:creator></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  "OEBPS/ch1.xhtml": `<html><body><h2>${CHAPTER_ONE}</h2><p>${CHAPTER_ONE}</p></body></html>`,
  "OEBPS/ch2.xhtml": `<html><body><h2>${CHAPTER_TWO}</h2><p>${CHAPTER_TWO}</p></body></html>`,
});

const FB2_TEXT = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info>
    <book-title>Пустыня и караван</book-title>
    <author><first-name>Пётр</first-name><last-name>Ветер</last-name></author>
  </title-info></description>
  <body>
    <section>
      <title><p>Часть первая</p></title>
      <section><title><p>Дорога</p></title><p>${CHAPTER_ONE}</p></section>
      <section><title><p>Встреча</p></title><p>${CHAPTER_TWO}</p></section>
    </section>
  </body>
  <body name="notes">
    <section><title><p>Комментарии</p></title><p>Сноска, которой не должно быть в тексте книги.</p></section>
  </body>
</FictionBook>`;

test("parseBookBuffer распознаёт epub, fb2 и txt по сигнатуре", () => {
  const epub = parseBookBuffer("book.epub", EPUB_BUFFER);
  assert.equal(epub.kind, "epub");
  assert.equal(epub.title, "Тестовая книга");
  assert.equal(epub.author, "Иван Тестов");
  assert.equal(epub.chapters.length, 2);

  const fb2 = parseBookBuffer("book.fb2", Buffer.from(FB2_TEXT, "utf8"));
  assert.equal(fb2.kind, "fb2");
  assert.equal(fb2.title, "Пустыня и караван");
  assert.equal(fb2.author, "Пётр Ветер");
  assert.ok(fb2.chapters.length >= 2, `глав слишком мало: ${fb2.chapters.length}`);

  const txt = parseBookBuffer("book.txt", Buffer.from(`Дорога\n\n${CHAPTER_ONE}`, "utf8"));
  assert.equal(txt.kind, "txt");
  assert.ok(txt.chapters.length >= 1);
});

test("fb2 не тащит в книгу тело сносок", () => {
  const parsed = parseBookBuffer("book.fb2", Buffer.from(FB2_TEXT, "utf8"));
  const allText = parsed.chapters.map((chapter) => chapter.text).join(" ");
  assert.ok(!allText.includes("Сноска"), 'текст из <body name="notes"> попал в книгу');
});

test("buildBookModel считает слова, смещения и границы глав", () => {
  const parsed = parseBookBuffer("book.epub", EPUB_BUFFER);
  const book = buildBookModel(parsed, { id: "test0001" });

  assert.equal(book.id, "test0001");
  assert.ok(book.words.length > 20);
  assert.equal(book.starts.length, book.words.length);
  assert.equal(book.ends.length, book.words.length);
  assert.equal(book.chapters.length, 2);

  // Смещения указывают в исходный текст — значит цитата режется «как в книге».
  const firstWord = book.text.slice(book.starts[0], book.ends[0]);
  assert.equal(firstWord.toLowerCase(), "глава");
});

test("describePosition определяет главу, процент и оценку страницы", () => {
  const book = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: "test0001" });
  const inSecondChapter = book.chapters[1].startWord;

  const atStart = describePosition(book, 0);
  assert.equal(atStart.chapterIndex, 0);
  assert.equal(atStart.percent, 0);
  assert.equal(atStart.pageEstimate, 1);
  assert.ok(atStart.totalPages >= 1);
  assert.equal(atStart.chapterCount, 2);

  const middle = describePosition(book, inSecondChapter);
  assert.equal(middle.chapterIndex, 1);
  assert.ok(middle.percent > 0);
  assert.equal(middle.wordPosition, inSecondChapter);
  assert.equal(middle.totalWords, book.words.length);
});

test("quoteFor режет цитату из оригинального текста, а не из нормализованного", () => {
  const book = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: "test0001" });
  const { quote, quoteTail } = quoteFor(book, 0, 6);

  assert.ok(/^Глава первая/.test(quote), `цитата потеряла регистр: «${quote}»`);
  assert.ok(quoteTail.length > 0);
});

test("locateByText находит страницу по тексту с опечатками OCR", () => {
  const book = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: "test0001" });
  const index = buildIndex(book.words);

  // «OCR» испортил три слова: вставка, замена и потеря буквы.
  const ocrText = CHAPTER_TWO.replace("Караван", "Караванн")
    .replace("пряностями", "пряностямн")
    .replace("высохшего", "высохшео");

  const result = locateByText(book, index, ocrText);

  assert.equal(result.ok, true);
  assert.equal(result.chapterIndex, 1);
  assert.ok(result.coverage > 0.8, `покрытие ${result.coverage}`);
  assert.ok(result.quote.length > 0);
});

test("locateByText отказывается искать слишком короткий фрагмент", () => {
  const book = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: "test0001" });
  const index = buildIndex(book.words);
  const result = locateByText(book, index, "караван");

  assert.equal(result.ok, false);
  assert.match(result.reason, /мало текста/);
});

test("wordsAround возвращает окно слов и не выходит за границы", () => {
  const book = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: "test0001" });

  assert.deepEqual(wordsAround(book, 5, 4), book.words.slice(5, 9));
  assert.deepEqual(wordsAround(book, book.words.length - 2, 10), book.words.slice(-2));
  assert.equal(wordsAround(book, -100, 3).length, 3);
});

test("BookStore сохраняет книгу с индексом и загружает их обратно с диска", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bookfind-store-"));
  try {
    const model = buildBookModel(parseBookBuffer("book.epub", EPUB_BUFFER), { id: bookId(EPUB_BUFFER) });
    const index = buildIndex(model.words);

    await new BookStore(dir).save(model, index);
    const savedMeta = JSON.parse(await readFile(path.join(dir, model.id, "book.json"), "utf8"));
    assert.equal(savedMeta.title, "Тестовая книга");

    // Новый экземпляр хранилища — читает только с диска (кэш в памяти пуст).
    const reader = new BookStore(dir);
    const loaded = await reader.load(model.id);
    assert.ok(loaded, "книга не загрузилась с диска");
    assert.equal(loaded.book.title, "Тестовая книга");
    assert.equal(loaded.index.size, model.words.length, "индекс восстановлен не целиком");

    const located = locateByText(loaded.book, loaded.index, CHAPTER_ONE);
    assert.equal(located.ok, true);
    assert.equal(located.chapterIndex, 0);

    const list = await reader.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "Тестовая книга");
    assert.equal(list[0].words, model.words.length);

    await reader.remove(model.id);
    assert.equal((await reader.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

