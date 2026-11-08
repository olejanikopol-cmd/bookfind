// FB2 и TXT -> главы + метаданные. Без внешних зависимостей: FB2 — XML,
// разбираем потоковым сканером тегов (нужны только section/title/p/v).
import { readFile } from "node:fs/promises";
import { decodeEntities } from "./epub.js";

/** Определяет кодировку файла: BOM, валидный UTF-8 или объявление в XML. */
export function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // не UTF-8 — смотрим объявленную кодировку, иначе классика рунета
    const head = buffer.subarray(0, 400).toString("latin1");
    const declared = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
    if (declared) {
      try {
        return new TextDecoder(declared.toLowerCase()).decode(buffer);
      } catch {
        /* падаем ниже на cp1251 */
      }
    }
    return new TextDecoder("windows-1251").decode(buffer);
  }
}

const TOKEN_RE = /<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
const BLOCK_TAGS = new Set(["p", "v", "subtitle", "text-author", "date", "empty-line", "cite", "epigraph", "poem", "stanza"]);

/** Разбирает <body> FB2 в дерево секций: { title, parts, children }. */
export function parseFb2Sections(bodyXml) {
  const root = { title: "", parts: [], children: [] };
  const stack = [root];
  let titleBuf = null;
  let titleTarget = null;

  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(bodyXml);
  while (match) {
    const [, closeName, openName, , selfClosing, rawText] = match;

    if (rawText !== undefined) {
      const current = stack[stack.length - 1];
      if (titleBuf !== null) {
        titleBuf.push(rawText);
      } else if (current) {
        current.parts.push(decodeEntities(rawText));
      }
      match = TOKEN_RE.exec(bodyXml);
      continue;
    }

    const name = (closeName || openName).toLowerCase();

    if (closeName) {
      if (name === "title" && titleBuf !== null) {
        if (titleTarget) {
          titleTarget.title = titleBuf
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        }
        titleBuf = null;
        titleTarget = null;
      } else if (name === "section" && stack.length > 1) {
        stack.pop();
      } else if (BLOCK_TAGS.has(name)) {
        const current = stack[stack.length - 1];
        if (current) current.parts.push("\n");
      }
      match = TOKEN_RE.exec(bodyXml);
      continue;
    }

    if (selfClosing) {
      if (name === "empty-line") {
        const current = stack[stack.length - 1];
        if (current) current.parts.push("\n");
      }
      match = TOKEN_RE.exec(bodyXml);
      continue;
    }

    if (name === "title") {
      titleBuf = [];
      titleTarget = stack[stack.length - 1] ?? null;
    } else if (name === "section") {
      const current = stack[stack.length - 1];
      const section = { title: "", parts: [], children: [] };
      if (current) current.children.push(section);
      stack.push(section);
    } else if (BLOCK_TAGS.has(name)) {
      const current = stack[stack.length - 1];
      if (current) current.parts.push("\n");
    }

    match = TOKEN_RE.exec(bodyXml);
  }

  return root;
}

/**
 * Обход дерева в порядке документа: листовая секция = глава.
 * Собственный текст секции-контейнера приклеиваем к её первой дочерней главе,
 * чтобы текст не дублировался и не терялся.
 */
export function flattenSections(root) {
  const chapters = [];

  function walk(node, pending) {
    const ownText = node.parts
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (node.children.length === 0) {
      const text = [pending, ownText].filter(Boolean).join("\n\n").trim();
      if (text.length > 0) {
        chapters.push({
          title: node.title || `Часть ${chapters.length + 1}`,
          text,
        });
        return "";
      }
      // Пустая секция (титул, разделитель) — не теряем накопленный текст.
      return pending;
    }

    let carried = [pending, ownText].filter(Boolean).join("\n\n").trim();
    for (const child of node.children) {
      carried = walk(child, carried) ?? "";
    }
    if (carried) {
      // Текст после последней дочерней секции — самостоятельный фрагмент.
      chapters.push({ title: node.title || `Часть ${chapters.length + 1}`, text: carried });
    }
    return "";
  }

  for (const child of root.children) {
    walk(child, "");
  }
  return chapters;
}

function cleanText(value) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

/** Разбирает FB2-буфер: метаданные + главы. */
export function parseFb2(buffer) {
  const xml = decodeTextBuffer(buffer);

  const titleMatch = /<book-title\b[^>]*>([\s\S]*?)<\/book-title>/i.exec(xml);
  const title = titleMatch ? cleanText(titleMatch[1]) : "Без названия";

  const authors = [];
  const titleInfo = /<title-info\b[^>]*>([\s\S]*?)<\/title-info>/i.exec(xml)?.[1] ?? "";
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
  let authorMatch = authorRe.exec(titleInfo);
  while (authorMatch) {
    const person = authorMatch[1];
    const parts = ["first-name", "middle-name", "last-name"]
      .map((tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(person)?.[1])
      .filter(Boolean)
      .map(cleanText);
    const nickname = /<nickname\b[^>]*>([\s\S]*?)<\/nickname>/i.exec(person)?.[1];
    const name = parts.length > 0 ? parts.join(" ") : nickname ? cleanText(nickname) : "";
    if (name) authors.push(name);
    authorMatch = authorRe.exec(titleInfo);
  }

  // Тела с примечаниями/комментариями в основной текст не берём.
  const bodyParts = [];
  const bodyRe = /<body\b([^>]*)>([\s\S]*?)<\/body>/gi;
  let bodyMatch = bodyRe.exec(xml);
  while (bodyMatch) {
    const attrs = bodyMatch[1];
    if (!/notes|comments|footnotes/i.test(attrs)) bodyParts.push(bodyMatch[2]);
    bodyMatch = bodyRe.exec(xml);
  }
  const bodyXml = bodyParts.length > 0 ? bodyParts.join("\n") : xml;

  const chapters = flattenSections(parseFb2Sections(bodyXml));
  if (chapters.length === 0) throw new Error("в FB2 не найдено текста");

  return { title, author: authors.join(", "), kind: "fb2", chapters };
}

const HEADING_RE = /^(глава|часть|книга|chapter|part|prologue|epilogue|пролог|эпилог|предисловие|послесловие|примечания)\b/i;

/** Разбирает TXT: главы по строкам-заголовкам, иначе одна глава. */
export function parseTxt(buffer) {
  const text = decodeTextBuffer(buffer).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const chapters = [];
  let current = { title: "", lines: [] };

  const flush = () => {
    const body = current.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body.length > 0) chapters.push({ title: current.title || `Часть ${chapters.length + 1}`, text: body });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading =
      trimmed.length > 0 &&
      trimmed.length <= 80 &&
      (HEADING_RE.test(trimmed) ||
        (trimmed.length <= 60 && /^[A-ZА-ЯЁ0-9IVXLC .\-–—:«»"]+$/.test(trimmed) && trimmed.replace(/[^\p{L}]/gu, "").length >= 3));
    if (isHeading) {
      flush();
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  if (chapters.length === 0) chapters.push({ title: "Текст", text: text.trim() });

  return { title: "", author: "", kind: "txt", chapters };
}
