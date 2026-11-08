// Препроцессинг фото страницы перед OCR через системный ffmpeg:
// увеличение x2 (Lanczos), оттенки серого, unsharp, подъём контраста.
// Дополнительно — автообрезка чёрных полей по cropdetect (скриншоты, тёмные рамки).
import { spawn } from "node:child_process";

const ENHANCE_FILTER = "scale=iw*2:ih*2:flags=lanczos,format=gray,unsharp=5:5:0.8,eq=contrast=1.3";

function runFfmpeg(args, input, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    const out = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg не ответил вовремя"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-300)}`));
        return;
      }
      resolve({ buffer: Buffer.concat(out), stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Ищем чёрные поля: полезно для скриншотов с рамками, для фото страницы обычно no-op.
async function detectCrop(buffer) {
  try {
    const { stderr } = await runFfmpeg(
      ["-hide_banner", "-nostats", "-i", "pipe:0", "-vf", "cropdetect=24:2:0", "-frames:v", "3", "-f", "null", "-"],
      buffer,
      20000,
    );
    const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (matches.length === 0) return null;
    const [, w, h, x, y] = matches[matches.length - 1].map(Number);
    if (!w || !h) return null;
    return { width: w, height: h, x, y };
  } catch {
    return null;
  }
}

/**
 * Улучшает изображение для OCR. При любой ошибке возвращает исходный буфер —
 * без препроцессинга сервис остаётся работоспособным.
 * @param {Buffer} buffer
 * @param {{ enhance?: boolean, trim?: boolean }} [options]
 */
export async function preprocessImage(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  const enhance = options.enhance !== false;
  const trim = options.trim === true;

  let filter = enhance ? ENHANCE_FILTER : "null";
  if (trim) {
    const crop = await detectCrop(buffer);
    if (crop) filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},${filter}`;
  }

  try {
    const { buffer: out } = await runFfmpeg(
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
      buffer,
    );
    return out.length > 0 ? out : buffer;
  } catch {
    return buffer;
  }
}

/** Проверяет, что ffmpeg доступен в системе. */
export async function ffmpegAvailable() {
  try {
    await runFfmpeg(["-hide_banner", "-version"], Buffer.alloc(0), 8000);
    return true;
  } catch {
    return false;
  }
}

export default { preprocessImage, ffmpegAvailable };
