import assert from "node:assert/strict";
import { test } from "node:test";

import { alignToSubtitles, parseYouTubeId, youtubeUrlAt } from "../server/align.js";
import { formatTimecode, parseTimestamp, parseVtt, vttToWords } from "../server/vtt.js";
import { tokenizeWords } from "../server/normalize.js";

// Roll-up субтитры YouTube: каждая реплика повторяет хвост предыдущей.
const ROLLUP_VTT = `WEBVTT
Kind: captions
Language: ru

00:00:01.000 --> 00:00:04.000
мы вышли из дома

00:00:04.000 --> 00:00:07.000
мы вышли из дома и сразу попали под дождь

00:00:07.000 --> 00:00:10.000
и сразу попали под дождь было холодно

00:00:10.000 --> 00:00:13.000
было холодно и мы вернулись
`;

// Обычные (не roll-up) субтитры с пословной разметкой <time>.
const WORD_TIMED_VTT = `WEBVTT

00:00:20.000 --> 00:00:24.000
<00:00:20.000>Полетел <00:00:21.500>под <00:00:22.800>откос <00:00:24.000>поезд
`;

test("parseTimestamp понимает часы, минуты и запятую как разделитель", () => {
  assert.equal(parseTimestamp("00:01:23.450"), 83.45);
  assert.equal(parseTimestamp("01:00:00.000"), 3600);
  assert.equal(parseTimestamp("00:00:05,500"), 5.5);
  assert.equal(parseTimestamp("02:30"), 150);
});

test("formatTimecode опускает часы, пока они нулевые", () => {
  assert.equal(formatTimecode(83.4), "1:23");
  assert.equal(formatTimecode(3725), "1:02:05");
  assert.equal(formatTimecode(0), "0:00");
});

test("parseVtt разбирает реплики и отбрасывает технические вставки", () => {
  const cues = parseVtt(ROLLUP_VTT);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[3].end, 13);
  assert.match(cues[1].text, /попали под дождь/);
});

test("vttToWords склеивает roll-up без дублей и с монотонным временем", () => {
  const { words, duration } = vttToWords(ROLLUP_VTT);

  // Ожидаемый поток: каждая реплика добавляет только новый хвост.
  assert.deepEqual(
    words.map((item) => item.word),
    ["мы", "вышли", "из", "дома", "и", "сразу", "попали", "под", "дождь", "было", "холодно", "и", "мы", "вернулись"],
  );

  for (let i = 1; i < words.length; i += 1) {
    assert.ok(words[i].start >= words[i - 1].start, "время должно быть неубывающим");
  }
  assert.ok(duration > 10 && duration <= 13.5, `подозрительная длительность: ${duration}`);
});


test("vttToWords использует пословные таймкоды из <time>", () => {
  const { words } = vttToWords(WORD_TIMED_VTT);
  assert.equal(words.length, 4);
  assert.equal(words[0].word, "полетел");
  assert.equal(words[0].start, 20);
  assert.equal(words[1].word, "под");
  assert.equal(words[1].start, 21.5);
  assert.equal(words[3].start, 24);
});

test("parseYouTubeId понимает все формы ссылок", () => {
  const id = "tR0Z6-84F3o";
  assert.equal(parseYouTubeId(id), id);
  assert.equal(parseYouTubeId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(parseYouTubeId(`https://www.youtube.com/watch?v=${id}&t=120s`), id);
  assert.equal(parseYouTubeId(`https://youtu.be/${id}?t=90`), id);
  assert.equal(parseYouTubeId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(parseYouTubeId("https://example.com/video"), null);
  assert.equal(parseYouTubeId(""), null);
});

test("youtubeUrlAt ставит целую секунду в ?t=", () => {
  assert.equal(youtubeUrlAt("tR0Z6-84F3o", 149.7), "https://youtu.be/tR0Z6-84F3o?t=149");
  assert.equal(youtubeUrlAt("tR0Z6-84F3o", -5), "https://youtu.be/tR0Z6-84F3o?t=0");
});

test("alignToSubtitles возвращает секунду начала фразы", () => {
  const { words } = vttToWords(ROLLUP_VTT);
  const aligned = alignToSubtitles(words, tokenizeWords("и сразу попали под дождь было холодно"));

  assert.equal(aligned.ok, true);
  assert.equal(aligned.seconds, 4);
  assert.equal(aligned.timecode, "0:04");
  assert.ok(aligned.coverage >= 0.9, `покрытие ${aligned.coverage}`);
  assert.ok(aligned.matchedWord.length > 0, "должно быть указано, на каком слове совпало");
});

test("alignToSubtitles честно отказывается, если фразы нет в субтитрах", () => {
  const { words } = vttToWords(ROLLUP_VTT);
  const aligned = alignToSubtitles(words, tokenizeWords("квантовая хромодинамика объясняет конфайнмент глюонов"));

  assert.equal(aligned.ok, false);
  assert.equal(aligned.seconds, null);
  assert.equal(aligned.confidence, "low");
});

test("alignToSubtitles не падает на пустых входах", () => {
  assert.equal(alignToSubtitles([], ["слово"]).ok, false);
  assert.equal(alignToSubtitles([{ word: "слово", start: 0, end: 1 }], []).ok, false);
});
