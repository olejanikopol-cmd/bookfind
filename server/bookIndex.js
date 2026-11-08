// Пословный индекс книги и поиск окна («где эта страница в книге?»).
//
// Идея: точное вхождение слова ищется по Map<word, positions[]>. Для опечаток OCR
// (а OCR всегда путает буквы) держим deletion-индекс: для каждого слова длиной >= 5
// храним все варианты с удалением одной буквы. Тогда слово с одной ошибкой
// (замена/вставка/удаление) находится за O(len) запросов вместо перебора словаря.
//
// Поиск окна:
//  1) по редким (IDF-тяжёлым) словам запроса собираем «голоса» за позицию-якорь;
//  2) топ-K якорей проверяем полным выравниванием запроса с окном книги;
//  3) побеждает окно с максимальным IDF-взвешенным покрытием.

const DELETION_MIN_LEN = 5;
const DELETION_MAX_LEN = 24;

/**
 * Строит индекс по массиву нормализованных слов.
 * @param {string[]} words
 */
export function buildIndex(words) {
  /** @type {Map<string, number[]>} */
  const positions = new Map();
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word) continue;
    const list = positions.get(word);
    if (list) list.push(i);
    else positions.set(word, [i]);
  }

  const deletions = buildDeletionIndex(positions);
  return { words, positions, deletions, size: words.length };
}

function buildDeletionIndex(positions) {
  /** @type {Map<string, number[]>} */
  const deletions = new Map();
  for (const [word, list] of positions) {
    if (word.length < DELETION_MIN_LEN || word.length > DELETION_MAX_LEN) continue;
    for (let i = 0; i < word.length; i += 1) {
      const variant = word.slice(0, i) + word.slice(i + 1);
      const existing = deletions.get(variant);
      if (existing) {
        for (let k = 0; k < list.length; k += 1) existing.push(list[k]);
      } else {
        deletions.set(variant, list.slice());
      }
    }
  }
  return deletions;
}

/** Кандидаты-позиции для слова запроса: [{ pos, quality }]. quality=1 точное, 0.8 — одна правка. */
function candidatesFor(index, word) {
  const out = [];
  const exact = index.positions.get(word);
  if (exact) {
    for (let i = 0; i < exact.length; i += 1) out.push({ pos: exact[i], quality: 1 });
  }
  if (word.length >= DELETION_MIN_LEN) {
    const seen = new Set(exact ? exact : []);
    // Вариант «слово запроса без одной буквы» совпадает с вариантом «слово книги без
    // одной буквы» ровно тогда, когда слова отличаются на одну правку.
    for (let i = 0; i < word.length; i += 1) {
      const variant = word.slice(0, i) + word.slice(i + 1);
      const hits = index.deletions.get(variant);
      if (!hits) continue;
      for (let k = 0; k < hits.length; k += 1) {
        const pos = hits[k];
        if (seen.has(pos)) continue;
        seen.add(pos);
        out.push({ pos, quality: 0.8 });
      }
    }
  }
  return out;
}

function idfOf(index, word) {
  const list = index.positions.get(word);
  const df = list ? list.length : 1;
  return Math.log(1 + index.size / (df + 0.5));
}

function sharePrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function wordWeight(docWord, queryWord) {
  if (docWord === queryWord) return 1;
  if (docWord.length < 4 || queryWord.length < 4) return 0;
  if (Math.abs(docWord.length - queryWord.length) > 1) return 0;
  return sharePrefix(docWord, queryWord) >= 3 ? 0.8 : 0;
}

// Взвешенное выравнивание запроса с фрагментом книги.
// coverage — доля слов запроса, подтверждённых с весом (точное совпадение = 1);
// run     — максимальная непрерывная цепочка подтверждений;
// exactCoverage — доля строго точных совпадений.
function verifyWindow(index, queryWords, start) {
  const doc = index.words;
  const qlen = queryWords.length;
  const windowLen = Math.min(doc.length - start, Math.ceil(qlen * 1.35) + 6);
  if (windowLen <= 0) return null;

  const EPS = 1e-9;
  const dp = Array.from({ length: qlen + 1 }, () => new Float64Array(windowLen + 1));
  const run = Array.from({ length: qlen + 1 }, () => new Uint16Array(windowLen + 1));
  const exact = Array.from({ length: qlen + 1 }, () => new Uint16Array(windowLen + 1));

  for (let i = 1; i <= qlen; i += 1) {
    const qw = queryWords[i - 1];
    for (let j = 1; j <= windowLen; j += 1) {
      let value = dp[i - 1][j];
      let runValue = run[i - 1][j];
      let exactValue = exact[i - 1][j];
      if (dp[i][j - 1] > value + EPS) {
        value = dp[i][j - 1];
        runValue = run[i][j - 1];
        exactValue = exact[i][j - 1];
      }
      const weight = wordWeight(doc[start + j - 1], qw);
      if (weight > 0) {
        const diagonal = dp[i - 1][j - 1] + weight;
        if (diagonal > value + EPS) {
          value = diagonal;
          runValue = run[i - 1][j - 1] + 1;
          exactValue = exact[i - 1][j - 1] + (weight === 1 ? 1 : 0);
        }
      }
      dp[i][j] = value;
      run[i][j] = runValue;
      exact[i][j] = exactValue;
    }
  }

  return {
    coverage: dp[qlen][windowLen] / qlen,
    run: run[qlen][windowLen],
    exactCoverage: exact[qlen][windowLen] / qlen,
    windowLen,
  };
}

const EMPTY = {
  startWord: -1,
  endWord: -1,
  coverage: 0,
  exactCoverage: 0,
  run: 0,
  score: 0,
  confidence: "low",
};

/**
 * Ищет окно книги, соответствующее запросу.
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string[]} queryWords нормализованные слова
 * @param {{ maxAnchors?: number, minCoverage?: number, maxCandidates?: number }} [options]
 */
export function findWindow(index, queryWords, options = {}) {
  const maxAnchors = options.maxAnchors ?? 24;
  const minCoverage = options.minCoverage ?? 0;
  const maxCandidates = options.maxCandidates ?? 400;
  const qlen = queryWords.length;
  if (qlen === 0 || !index || index.size === 0) return { ...EMPTY };

  // 1. Опорные слова: чем реже слово в книге, тем ценнее его позиция.
  const anchors = [];
  const seenWords = new Set();
  for (let qi = 0; qi < qlen; qi += 1) {
    const word = queryWords[qi];
    if (word.length <= 2 || seenWords.has(word)) continue;
    seenWords.add(word);
    const cands = candidatesFor(index, word);
    if (cands.length === 0) continue;
    anchors.push({ qi, idf: idfOf(index, word), cands });
  }
  if (anchors.length === 0) return { ...EMPTY };
  anchors.sort((a, b) => b.idf - a.idf);

  // 2. Голосование за позицию-якорь.
  const votes = new Map();
  for (const anchor of anchors.slice(0, 12)) {
    const cands = anchor.cands.length > maxCandidates ? anchor.cands.slice(0, maxCandidates) : anchor.cands;
    for (const { pos, quality } of cands) {
      const start = pos - anchor.qi;
      if (start < 0) continue;
      votes.set(start, (votes.get(start) ?? 0) + anchor.idf * quality);
    }
  }
  if (votes.size === 0) return { ...EMPTY };

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxAnchors);

  // 3. Верификация: якорь + небольшой сдвиг (страница могла начаться на пару слов раньше).
  let best = null;
  for (const [start, vote] of ranked) {
    for (let shift = 0; shift <= 3; shift += 1) {
      const from = start + shift;
      if (from < 0 || from >= index.size) continue;
      const checked = verifyWindow(index, queryWords, from);
      if (!checked) continue;
      const score = checked.coverage * (1 + Math.log(1 + vote)) * (0.5 + 0.5 * checked.exactCoverage);
      if (!best || score > best.score) {
        best = {
          startWord: from,
          endWord: Math.min(index.size - 1, from + checked.windowLen - 1),
          coverage: checked.coverage,
          exactCoverage: checked.exactCoverage,
          run: checked.run,
          score,
        };
      }
    }
  }
  if (!best) return { ...EMPTY };

  if (best.coverage < minCoverage) return { ...best, startWord: -1, endWord: -1, confidence: "low" };

  return { ...best, confidence: confidenceOf(best) };
}

export function confidenceOf({ coverage, run, exactCoverage }) {
  if (coverage >= 0.7 && run >= 5) return exactCoverage >= 0.5 ? "high" : "medium";
  if (coverage >= 0.45 && run >= 3) return "medium";
  return "low";
}

export default { buildIndex, findWindow, confidenceOf };
