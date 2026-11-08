// Клиент BookFind: без сборщика и зависимостей, обычный ES-модуль.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  books: [],
  bookId: "",
  lastPosition: null,
};

const fmtPercent = (value) => `${(Math.round(value * 10) / 10).toString().replace(".", ",")}%`;
const fmtNumber = (value) => new Intl.NumberFormat("ru-RU").format(value);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- вкладки ----------
function showTab(name) {
  $$(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $$(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));

// ---------- окружение ----------
async function loadHealth() {
  const node = $("#health");
  try {
    const health = await api("/api/health");
    const parts = [health.node];
    parts.push(health.ffmpeg ? "ffmpeg ✓" : "ffmpeg ✗");
    parts.push(health.ytdlp ? "yt-dlp ✓" : "yt-dlp ✗");
    parts.push(health.tessdata.ready ? "OCR ✓" : `OCR: нет моделей (${health.tessdata.missing.join(", ")})`);
    parts.push(`книг: ${health.books}`);
    node.textContent = parts.join(" · ");
    node.classList.toggle("muted--bad", !health.tessdata.ready);
  } catch (error) {
    node.textContent = `сервер недоступен: ${error.message}`;
  }
}

// ---------- библиотека ----------
function renderBooks() {
  const list = $("#book-list");
  const select = $("#book-select");
  list.textContent = "";
  select.textContent = "";

  if (state.books.length === 0) {
    select.append(new Option("— сначала загрузите книгу —", ""));
    list.append(el("li", "muted", "Пока пусто. Загрузите epub, fb2 или txt."));
    return;
  }

  for (const book of state.books) {
    select.append(new Option(`${book.title}${book.author ? ` — ${book.author}` : ""}`, book.id));

    const item = el("li", "book-item");
    const info = el("div");
    info.append(el("div", "book-item__title", book.title));
    info.append(el("div", "muted", `${book.author || "автор неизвестен"} · ${book.kind} · ${fmtNumber(book.words)} слов · ${book.chapters} глав`));

    const remove = el("button", null, "✕");
    remove.type = "button";
    remove.title = "Удалить книгу";
    remove.addEventListener("click", async () => {
      if (!confirm(`Удалить «${book.title}» из библиотеки?`)) return;
      await api(`/api/books/${book.id}`, { method: "DELETE" });
      await loadBooks();
    });

    item.append(info, remove);
    list.append(item);
  }

  if (!state.books.some((book) => book.id === state.bookId)) {
    state.bookId = state.books[0].id;
  }
  select.value = state.bookId;
}

async function loadBooks() {
  const data = await api("/api/books");
  state.books = data.books ?? [];
  renderBooks();
}

$("#book-select").addEventListener("change", (event) => {
  state.bookId = event.target.value;
});

async function uploadBook(file) {
  if (!file) return;
  const progress = $("#book-progress");
  progress.textContent = `Разбираю «${file.name}»…`;
  try {
    const dataBase64 = await fileToBase64(file);
    const result = await api("/api/books", { method: "POST", body: JSON.stringify({ name: file.name, dataBase64 }) });
    progress.textContent = `Готово: ${result.title} · ${fmtNumber(result.words)} слов · ${result.chapters} глав${result.cached ? " (из кэша)" : ` · ${result.ms} мс`}`;
    state.bookId = result.id;
    await loadBooks();
    await loadBookmarks();
  } catch (error) {
    progress.textContent = `Ошибка: ${error.message}`;
  }
}

$("#pick-book").addEventListener("click", () => $("#book-file").click());
$("#book-file").addEventListener("change", (event) => uploadBook(event.target.files?.[0]));

// ---------- drag & drop ----------
function setupDropzone(zoneSelector, onFile) {
  const zone = $(zoneSelector);
  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("is-over");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("is-over");
    }),
  );
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];

// ---------- поиск места в книге ----------
function chip(text, kind) {
  return el("span", `chip${kind ? ` chip--${kind}` : ""}`, text);
}

function renderLocateResult(result) {
  const box = $("#locate-result");
  box.textContent = "";
  box.hidden = false;

  if (!result.ok) {
    box.append(el("div", "result__headline", "Не удалось найти это место"));
    box.append(el("p", "muted", result.reason || "попробуйте другое фото"));
    if (result.ocr?.text) {
      box.append(el("p", "muted", "Распознанный текст:"));
      box.append(el("blockquote", "quote", result.ocr.text));
    }
    return;
  }

  state.lastPosition = {
    wordPosition: result.wordPosition,
    percent: result.percent,
    chapterTitle: result.chapterTitle,
    quote: result.quote,
  };

  box.append(
    el("div", "result__headline", `${result.chapterTitle} · ${fmtPercent(result.percent)} · ≈ стр. ${result.pageEstimate}`),
  );

  const meta = el("div", "result__meta");
  meta.append(chip(`глава ${result.chapterIndex + 1} из ${result.chapterCount}`));
  meta.append(chip(`≈ стр. ${result.pageEstimate} / ${result.totalPages}`));
  meta.append(chip(`совпадение ${Math.round(result.coverage * 100)}%`, result.confidence));
  meta.append(chip(`слов в запросе: ${result.queryWords}`));
  box.append(meta);

  box.append(el("blockquote", "quote", `«${result.quote}»`));

  const actions = el("div", "row");

  const copy = el("button", "btn", "Копировать цитату");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.quote);
    copy.textContent = "Скопировано";
    setTimeout(() => {
      copy.textContent = "Копировать цитату";
    }, 1500);
  });

  const save = el("button", "btn", "В закладки");
  save.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify({
          bookId: state.bookId,
          bookTitle: state.books.find((book) => book.id === state.bookId)?.title ?? "",
          wordPosition: result.wordPosition,
          chapterTitle: result.chapterTitle,
          percent: result.percent,
          quote: result.quote,
        }),
      });
      save.textContent = "Сохранено";
      await loadBookmarks();
    } catch (error) {
      save.textContent = `Ошибка: ${error.message}`;
    } finally {
      save.disabled = false;
    }
  });

  const toAudio = el("button", "btn btn--primary", "Секунда в аудио");
  toAudio.type = "button";
  toAudio.addEventListener("click", () => {
    showTab("audio");
    findAudioByPosition();
  });

  actions.append(copy, save, toAudio);
  box.append(actions);
}

function requireBook() {
  if (!state.bookId) {
    alert("Сначала загрузите книгу во вкладке «Библиотека».");
    showTab("library");
    return false;
  }
  return true;
}

async function locateByImage(file) {
  if (!file || !requireBook()) return;
  const status = $("#ocr-status");
  const preview = $("#locate-preview");
  const resultBox = $("#locate-result");

  preview.hidden = false;
  $("#preview-image").src = URL.createObjectURL(file);
  status.textContent = "Распознаю текст и ищу страницу… это может занять пару секунд";
  resultBox.hidden = true;

  try {
    const dataBase64 = await fileToBase64(file);
    const result = await api("/api/locate", {
      method: "POST",
      body: JSON.stringify({ bookId: state.bookId, imageBase64: dataBase64 }),
    });
    const ocr = result.ocr ?? {};
    status.textContent = `OCR: ${ocr.confidence ?? "—"}% · строк ${ocr.keptLines ?? 0}/${ocr.lines ?? 0} · ${result.ms} мс`;
    renderLocateResult(result);
  } catch (error) {
    status.textContent = "";
    resultBox.hidden = false;
    resultBox.textContent = "";
    resultBox.append(el("div", "result__headline", "Ошибка"));
    resultBox.append(el("p", "muted", error.message));
  }
}

async function locateByText() {
  if (!requireBook()) return;
  const text = $("#page-text").value.trim();
  if (text.length < 12) {
    alert("Вставьте хотя бы одну строку текста со страницы.");
    return;
  }
  const resultBox = $("#locate-result");
  resultBox.hidden = false;
  resultBox.textContent = "Ищу…";
  try {
    const result = await api("/api/locate", {
      method: "POST",
      body: JSON.stringify({ bookId: state.bookId, text }),
    });
    renderLocateResult(result);
  } catch (error) {
    resultBox.textContent = `Ошибка: ${error.message}`;
  }
}

$("#pick-photo").addEventListener("click", () => $("#page-photo").click());
$("#page-photo").addEventListener("change", (event) => locateByImage(event.target.files?.[0]));
$("#locate-text").addEventListener("click", locateByText);

    if (file) onFile(file);
  });
}

// ---------- аудио ----------
function renderAudioResult(result) {
  const box = $("#audio-result");
  box.textContent = "";
  box.hidden = false;

  box.append(el("div", "result__headline", result.ok ? `Слушать с ${result.timecode}` : "Не удалось сопоставить"));

  const meta = el("div", "result__meta");
  meta.append(chip(`субтитры: ${fmtNumber(result.subtitleWords ?? 0)} слов`));
  meta.append(chip(`длительность ${result.subtitleDuration ?? "—"}`));
  if (result.ok) meta.append(chip(`совпадение ${Math.round(result.coverage * 100)}%`, result.confidence));
  meta.append(chip(`${result.ms} мс`));
  box.append(meta);

  if (!result.ok) {
    box.append(el("p", "muted", result.reason || "в субтитрах нет этого фрагмента"));
    return;
  }

  if (result.matchedWord) box.append(el("blockquote", "quote", `Совпало на слове «${result.matchedWord}»`));
  if (result.book) {
    box.append(el("p", "muted", `Страница: ${result.book.chapterTitle} · ${fmtPercent(result.book.percent)}`));
  }

  const row = el("div", "row");
  const open = el("a", "btn btn--primary", `Открыть на ${result.timecode}`);
  open.href = result.url;
  open.target = "_blank";
  open.rel = "noopener";
  row.append(open);
  box.append(row);

  if (result.qr) {
    const wrap = el("div", "row");
    const img = el("img", "qr");
    img.src = result.qr;
    img.alt = "QR на таймкод";
    wrap.append(img);
    box.append(wrap);
    box.append(el("p", "muted", "Наведите телефон, чтобы открыть этот таймкод на другом устройстве."));
  }
}

async function findAudio(payload) {
  const url = $("#yt-url").value.trim();
  if (!url) {
    alert("Вставьте ссылку на YouTube.");
    return;
  }
  const box = $("#audio-result");
  box.hidden = false;
  box.textContent = "Скачиваю субтитры и сопоставляю…";
  try {
    const result = await api("/api/audio/link", {
      method: "POST",
      body: JSON.stringify({ bookId: state.bookId, youtubeUrl: url, ...payload }),
    });
    renderAudioResult(result);
  } catch (error) {
    box.textContent = "";
    box.append(el("div", "result__headline", "Ошибка"));
    box.append(el("p", "muted", error.message));
  }
}

function findAudioByPosition() {
  if (!state.lastPosition) {
    alert("Сначала найдите страницу во вкладке «Где я» — тогда будет что искать в аудио.");
    return;
  }
  if (!requireBook()) return;
  findAudio({ wordPosition: state.lastPosition.wordPosition });
}

$("#audio-from-last").addEventListener("click", findAudioByPosition);
$("#audio-search-text").addEventListener("click", () => {
  const text = $("#audio-text").value.trim();
  if (text.length < 3) {
    alert("Вставьте фразу, которую слышите.");
    return;
  }
  findAudio({ text });
});

// ---------- закладки ----------
function renderBookmarks(bookmarks) {
  const list = $("#bookmark-list");
  list.textContent = "";
  if (bookmarks.length === 0) {
    list.append(el("li", "muted", "Закладок пока нет."));
    return;
  }
  for (const bookmark of bookmarks) {
    const item = el("li", "bookmark-item");
    const info = el("div");
    info.append(el("div", "book-item__title", bookmark.chapterTitle || bookmark.bookTitle || "Закладка"));
    const details = [fmtPercent(bookmark.percent)];
    if (bookmark.bookTitle) details.push(bookmark.bookTitle);
    if (bookmark.audioTimecode) details.push(`аудио ${bookmark.audioTimecode}`);
    info.append(el("div", "muted", details.join(" · ")));
    if (bookmark.quote) info.append(el("div", "muted", `«${bookmark.quote.slice(0, 90)}…»`));

    const remove = el("button", null, "✕");
    remove.type = "button";
    remove.title = "Удалить закладку";
    remove.addEventListener("click", async () => {
      await api(`/api/bookmarks/${bookmark.id}`, { method: "DELETE" });
      await loadBookmarks();
    });

    item.append(info, remove);
    list.append(item);
  }
}

async function loadBookmarks() {
  try {
    const data = await api("/api/bookmarks");
    renderBookmarks(data.bookmarks ?? []);
  } catch {
    /* сервер не ответил — не мешаем остальному интерфейсу */
  }
}

// ---------- старт ----------
setupDropzone("#dropzone", locateByImage);
setupDropzone("#book-dropzone", uploadBook);

await Promise.all([loadHealth(), loadBooks(), loadBookmarks()]);

