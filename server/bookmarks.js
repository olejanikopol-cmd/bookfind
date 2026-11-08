// Закладки: «где я остановился» — JSON-файл на диске, без БД.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class BookmarkStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {any[] | null} */
    this.items = null;
  }

  async load() {
    if (this.items) return this.items;
    const raw = await readFile(this.filePath, "utf8").catch(() => null);
    if (!raw) {
      this.items = [];
      return this.items;
    }
    try {
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.items ?? [], null, 2));
  }

  async list(bookId) {
    const items = await this.load();
    const filtered = bookId ? items.filter((item) => item.bookId === bookId) : items;
    return filtered.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async add(input) {
    const items = await this.load();
    const bookmark = {
      id: randomUUID(),
      bookId: String(input.bookId ?? ""),
      bookTitle: String(input.bookTitle ?? ""),
      wordPosition: Number(input.wordPosition ?? 0),
      chapterTitle: String(input.chapterTitle ?? ""),
      percent: Number(input.percent ?? 0),
      quote: String(input.quote ?? ""),
      note: String(input.note ?? ""),
      audioSeconds: input.audioSeconds === undefined || input.audioSeconds === null ? null : Number(input.audioSeconds),
      audioUrl: input.audioUrl ? String(input.audioUrl) : "",
      createdAt: new Date().toISOString(),
    };
    items.push(bookmark);
    await this.persist();
    return bookmark;
  }

  async remove(id) {
    const items = await this.load();
    const before = items.length;
    this.items = items.filter((item) => item.id !== id);
    if (this.items.length !== before) await this.persist();
    return before !== this.items.length;
  }
}

export default { BookmarkStore };
