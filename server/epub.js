// Чтение EPUB без внешних зависимостей: ZIP по central directory через node:zlib,
// OPF (container.xml -> .opf) для порядка глав, XHTML -> текст.
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  copy: "©",
  deg: "°",
  times: "×",
  minus: "−",
  bull: "•",
  middot: "·",
  sect: "§",
  para: "¶",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
};

/** Декодирует XML/HTML-сущности. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Определяет кодировку XML по заголовку и декодирует буфер. */
export function decodeXml(buffer) {
  const head = buffer.subarray(0, 400).toString("latin1");
  const match = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  const enc = (match ? match[1] : "utf-8").toLowerCase();
  try {
    return new TextDecoder(enc).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/** XHTML -> читаемый текст (абзацы через перевод строки). */
export function htmlToText(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutBlocks = withoutComments
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|td|dd|dt)\s*>/gi, "\n");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[ \t\u00a0\u2009\u202f]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Открывает ZIP-архив в памяти: карта записей + функция чтения. */
export function openZip(buffer) {
  const minPos = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("не ZIP-архив: не найден End of Central Directory");

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;

  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`повреждён central directory ZIP на записи ${n}`);
    }
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function readRaw(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOC_SIG) {
      throw new Error(`повреждён local header ZIP: ${name}`);
    }
    const nameLen = buffer.readUInt16LE(local + 26);
    const extraLen = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLen + extraLen;
    const raw = buffer.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`неподдерживаемый метод сжатия ZIP (${entry.method}): ${name}`);
  }

  return { entries, readRaw };
}

/** Разрешает href относительно каталога, нормализуя ./ и ../ */
export function resolvePath(baseDir, href) {
  const clean = href.split("#")[0];
  const parts = (baseDir ? `${baseDir}/${clean}` : clean).split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function directoryOf(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function firstHeadingTitle(html) {
  const heading = /<h[1-3][^>]*>([\s\S]{1,300}?)<\/h[1-3]>/i.exec(html);
  if (heading) {
    const text = htmlToText(heading[1]).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  // fb2->epub конвертеры часто кладут заголовок в <div class="title*">.
  const titleClass = /<(div|p|span)\b[^>]*class\s*=\s*["'][^"']*title[^"']*["'][^>]*>([\s\S]{1,300}?)<\/\1>/i.exec(html);
  if (titleClass) {
    const text = htmlToText(titleClass[2]).replace(/\s+/g, " ").trim();
    if (text && text.length <= 120) return text;
  }
  const title = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  if (title) {
    const text = htmlToText(title[1]).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/** Разбирает EPUB-буфер: метаданные + главы в порядке spine. */
export function parseEpub(buffer) {
  const zip = openZip(buffer);

  const containerBuffer = zip.readRaw("META-INF/container.xml");
  if (!containerBuffer) throw new Error("не EPUB: нет META-INF/container.xml");
  const container = decodeXml(containerBuffer);
  const rootMatch = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container);
  if (!rootMatch) throw new Error("не EPUB: в container.xml не указан rootfile");
  const opfPath = rootMatch[1];
  const opfDir = directoryOf(opfPath);

  const opfBuffer = zip.readRaw(opfPath);
  if (!opfBuffer) throw new Error(`не EPUB: не найден OPF ${opfPath}`);
  const opf = decodeXml(opfBuffer);

  const manifest = new Map();
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let itemMatch = itemRe.exec(opf);
  while (itemMatch) {
    const attrs = itemMatch[1];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (id && href) {
      manifest.set(id, {
        href,
        type: /\bmedia-type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "",
      });
    }
    itemMatch = itemRe.exec(opf);
  }

  const spine = [];
  const itemrefRe = /<itemref\b([^>]*?)\/?>/gi;
  let refMatch = itemrefRe.exec(opf);
  while (refMatch) {
    const idref = /\bidref\s*=\s*["']([^"']+)["']/i.exec(refMatch[1])?.[1];
    if (idref) spine.push(idref);
    refMatch = itemrefRe.exec(opf);
  }

  const titleMatch = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const title = titleMatch ? htmlToText(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  const authors = [];
  const creatorRe = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi;
  let creatorMatch = creatorRe.exec(opf);
  while (creatorMatch) {
    const name = htmlToText(creatorMatch[1]).replace(/\s+/g, " ").trim();
    if (name) authors.push(name);
    creatorMatch = creatorRe.exec(opf);
  }

  const chapters = [];
  const order = spine.length > 0 ? spine : [...manifest.keys()];
  for (const id of order) {
    const item = manifest.get(id);
    if (!item) continue;
    if (item.type && !/x?html|xml/i.test(item.type)) continue;
    const path = resolvePath(opfDir, item.href);
    const data = zip.readRaw(path);
    if (!data) continue;
    const html = decodeXml(data);
    const text = htmlToText(html);
    // Пустые титульные страницы и «обложки» без текста пропускаем.
    if (text.replace(/\s+/g, "").length < 20) continue;
    const heading = firstHeadingTitle(html);
    chapters.push({ title: heading || `Часть ${chapters.length + 1}`, text, path });
  }

  if (chapters.length === 0) throw new Error("в EPUB не найдено текстовых глав");

  return { title: title || "Без названия", author: authors.join(", "), chapters, kind: "epub" };
}

/** Читает EPUB с диска. */
export async function readEpubFile(filePath) {
  const buffer = await readFile(filePath);
  return parseEpub(buffer);
}
