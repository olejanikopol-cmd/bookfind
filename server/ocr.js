// OCR страницы: tesseract.js (WASM) с локальными моделями rus+eng.
// Работает полностью офлайн: путь к tessdata задаётся в конфиге, скачивания нет.
import { existsSync } from "node:fs";
import path from "node:path";

import { createWorker, OEM, PSM } from "tesseract.js";

let workerPromise = null;
let workerLogger = null;

/** Проверяет наличие файлов моделей в каталоге tessdata. */
export function tessdataStatus(tessdataDir, langs = ["rus", "eng"]) {
  const missing = langs.filter((lang) => !existsSync(path.join(tessdataDir, `${lang}.traineddata`)));
  return { dir: tessdataDir, missing, ready: missing.length === 0 };
}

/**
 * Ленивая инициализация воркера (один на процесс: WASM грузится ~1 c).
 * @param {{ tessdataDir: string, cachePath: string, logger?: (m: any) => void }} config
 */
export async function getWorker(config) {
  if (workerLogger === null) workerLogger = config.logger ?? null;
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["rus", "eng"], OEM.LSTM_ONLY, {
        langPath: config.tessdataDir,
        cachePath: config.cachePath,
        gzip: false,
        logger: config.logger ?? (() => {}),
        errorHandler: (error) => console.error("[ocr]", error?.message ?? error),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });
      return worker;
    })();
  }
  return workerPromise;
}

/** Освобождает воркер (для тестов и корректного выхода). */
export async function shutdownOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* уже мёртв */
  }
}

const MIN_LINE_CONFIDENCE = 40;

/**
 * Распознаёт текст на изображении.
 * Строки с уверенностью ниже порога отбрасываем: они приносят больше шума, чем пользы.
 * @param {Buffer} imageBuffer
 * @param {{ tessdataDir: string, cachePath: string, logger?: (m: any) => void }} config
 * @returns {Promise<{ text: string, confidence: number, lines: number, keptLines: number }>}
 */
export async function recognizeImage(imageBuffer, config) {
  const worker = await getWorker(config);
  const { data } = await worker.recognize(imageBuffer);

  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  const kept = rawLines
    .map((line) => ({ text: String(line.text ?? "").trim(), confidence: Number(line.confidence ?? 0) }))
    .filter((line) => line.text.length > 0 && line.confidence >= MIN_LINE_CONFIDENCE);

  const text = kept.length > 0 ? kept.map((line) => line.text).join("\n") : String(data.text ?? "").trim();
  const confidence = rawLines.length > 0 ? kept.reduce((sum, line) => sum + line.confidence, 0) / Math.max(1, kept.length) : Number(data.confidence ?? 0);

  return {
    text,
    confidence: Math.round(confidence * 10) / 10,
    lines: rawLines.length,
    keptLines: kept.length,
  };
}

export default { getWorker, recognizeImage, shutdownOcr, tessdataStatus };
