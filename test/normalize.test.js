import assert from "node:assert/strict";
import { test } from "node:test";

import { editDistanceAtMost, normalize, tokenize } from "../server/normalize.js";

test("normalize сохраняет длину строки — смещения слов применимы к исходному тексту", () => {
  const samples = [
    "Привет, мир!",
    "Ёжик — в тумане…",
    "«Кавычки» и тире – 42",
    "Hello, WORLD 5",
    "a\tb\nc\r\n",
    "многострочный\n\nтекст   с   пробелами",
  ];
  for (const sample of samples) {
    assert.equal(normalize(sample).length, sample.length, `длина изменилась на «${sample}»`);
  }
});

test("normalize приводит регистр и ё к е", () => {
  assert.equal(normalize("ЁЖИК").trim(), "ежик");
  assert.equal(normalize("Привет").trim(), "привет");
});

test("normalize заменяет пунктуацию пробелами, а не удаляет", () => {
  assert.equal(normalize("Привет, мир!"), "привет  мир ");
});

test("normalize складывает гомоглифы латиница -> кириллица", () => {
  // OCR часто читает «с» как латинскую c — без фолдинга слово не находится.
  assert.equal(normalize("cлово").trim(), "слово");
  // латинские x, o, p вместо кириллических
  assert.equal(normalize("xopoшо").trim(), "хорошо");
  assert.equal(normalize("pабота").trim(), "работа");
  // идемпотентность: повторная нормализация ничего не меняет
  const once = normalize("Прыжок через обрыв");
  assert.equal(normalize(once), once);
});

test("tokenize возвращает слова с координатами в исходной строке", () => {
  const text = "Привет, мир! Ёжик 42";
  const { words, starts, ends } = tokenize(text);

  assert.deepEqual(words, ["привет", "мир", "ежик", "42"]);
  assert.deepEqual(starts, [0, 8, 13, 18]);
  assert.deepEqual(ends, [6, 11, 17, 20]);

  for (let i = 0; i < words.length; i += 1) {
    const original = text.slice(starts[i], ends[i]);
    assert.equal(normalize(original), words[i]);
  }
});

test("tokenize на пустом входе возвращает пустые массивы", () => {
  assert.deepEqual(tokenize(""), { words: [], starts: [], ends: [] });
  assert.deepEqual(tokenize(null), { words: [], starts: [], ends: [] });
});

test("editDistanceAtMost различает 1 и 2 правки", () => {
  assert.equal(editDistanceAtMost("слово", "слово", 1), 0);
  assert.equal(editDistanceAtMost("слово", "слова", 1), 1);
  assert.equal(editDistanceAtMost("слово", "слво", 1), 1);
  assert.equal(editDistanceAtMost("слово", "слава", 1), 2);
  assert.equal(editDistanceAtMost("кот", "пёс", 1), 2);
});
