import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, confidenceOf, findWindow } from "../server/bookIndex.js";
import { tokenizeWords } from "../server/normalize.js";

// Синтетическая «книга»: у каждого абзаца есть уникальное слово-метка,
// иначе абзацы неразличимы и позицию невозможно проверить.
const SYLLABLES = ["ка", "ро", "ми", "ту", "не", "ва", "лу", "си", "до", "пе", "за", "гу", "бы", "чи", "хо", "же"];

function uniqueWord(paragraph, salt) {
  const a = SYLLABLES[(paragraph + salt) % SYLLABLES.length];
  const b = SYLLABLES[(paragraph * 3 + salt * 5) % SYLLABLES.length];
  const c = SYLLABLES[(paragraph * 7 + salt * 11) % SYLLABLES.length];
  return `${a}${b}${c}${paragraph}${salt}`;
}

function makeBook(paragraphs = 40) {
  const chunks = [];
  for (let p = 0; p < paragraphs; p += 1) {
    chunks.push(
      `Абзац ${p}: ${uniqueWord(p, 1)} повествует о страннике, который пересёк ${uniqueWord(p, 2)} пустыню и встретил караван торговцев.`,
    );
  }
  return chunks.join("\n\n");
}


const text = makeBook();
const bookWords = tokenizeWords(text);
const index = buildIndex(bookWords);

// Начало каждого абзаца в номерах слов — считаем из самого текста,
// чтобы тесты не зависели от «магических» смещений.
const paragraphStarts = [];
{
  let acc = 0;
  for (const paragraph of text.split("\n\n")) {
    paragraphStarts.push(acc);
    acc += tokenizeWords(paragraph).length;
  }
}
const at = (paragraph) => paragraphStarts[paragraph];

test("индекс знает все слова и их количество", () => {
  assert.equal(index.size, bookWords.length);
  assert.equal(index.positions.get("страннике").length, 40);
  assert.ok(index.deletions.size > 0, "deletion-индекс должен быть не пуст");
});

test("точный фрагмент находится по своей позиции", () => {
  const from = at(25);
  const query = bookWords.slice(from, from + 12);
  const found = findWindow(index, query);

  assert.notEqual(found.startWord, -1);
  assert.equal(found.startWord, from);
  assert.equal(found.coverage, 1);
  assert.equal(found.confidence, "high");
});

test("слова с одной опечаткой OCR не мешают найти окно", () => {
  const from = at(12);
  const query = bookWords.slice(from, from + 12).map((word, i) => {
    if (i === 2) return `${word.slice(0, -1)}я`; // замена в первом уникальном слове
    if (i === 8) return `${word}н`; // вставка во второе уникальное слово
    if (word === "страннике") return "странныке"; // замена и -> ы
    return word;
  });

  const found = findWindow(index, query);
  assert.equal(found.startWord, from);
  assert.ok(found.coverage >= 0.9, `покрытие слишком низкое: ${found.coverage}`);
});

test("фрагмент с пропущенными словами всё равно находится", () => {
  const from = at(30);
  const query = bookWords.slice(from, from + 14).filter((_, i) => i % 4 !== 2);
  const found = findWindow(index, query);

  // Запрос «сжат» — окно может сместиться на пару слов, но должно накрыть нужное место.
  assert.notEqual(found.startWord, -1);
  assert.ok(Math.abs(found.startWord - from) <= 3, `окно уехало на ${found.startWord - from} слов`);
  const overlap = Math.min(found.startWord + query.length, from + 14) - Math.max(found.startWord, from);
  assert.ok(overlap >= 8, `окно почти не пересекается с фрагментом: ${overlap}`);
  assert.ok(found.coverage >= 0.8, `покрытие слишком низкое: ${found.coverage}`);
});

test("чужой фрагмент не даёт уверенного совпадения", () => {
  const found = findWindow(index, tokenizeWords("квантовая хромодинамика объясняет конфайнмент глюонов"));
  assert.ok(found.startWord === -1 || found.coverage < 0.5);
  assert.ok(found.confidence === "low" || found.startWord === -1);
});

test("minCoverage отсекает слабое совпадение", () => {
  const query = tokenizeWords("страннике пустыню караван");
  const loose = findWindow(index, query);
  const strict = findWindow(index, query, { minCoverage: 1.01 });

  assert.notEqual(loose.startWord, -1);
  assert.equal(strict.startWord, -1);
  assert.equal(strict.confidence, "low");
});

test("пустой запрос и пустой индекс не ломают поиск", () => {
  assert.equal(findWindow(index, []).startWord, -1);
  assert.equal(findWindow(buildIndex([]), ["слово"]).startWord, -1);
});


test("confidenceOf отражает покрытие и длину непрерывного участка", () => {
  assert.equal(confidenceOf({ coverage: 0.95, run: 8, exactCoverage: 0.9 }), "high");
  assert.equal(confidenceOf({ coverage: 0.95, run: 8, exactCoverage: 0.1 }), "medium");
  assert.equal(confidenceOf({ coverage: 0.5, run: 4, exactCoverage: 0.2 }), "medium");
  assert.equal(confidenceOf({ coverage: 0.2, run: 1, exactCoverage: 0 }), "low");
});
