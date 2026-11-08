// Скачивание субтитров YouTube через системный yt-dlp с кэшем на диске.
// Наружу уходит только запрос за субтитрами — сам сервис работает локально.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseYouTubeId } from "./align.js";

function runYtDlp(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp не ответил вовремя"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Проверяет наличие yt-dlp. */
export async function ytdlpAvailable() {
  try {
    const { code } = await runYtDlp(["--version"], 10000);
    return code === 0;
  } catch {
    return false;
  }
}

async function findCached(cacheDir, videoId) {
  const files = await readdir(cacheDir).catch(() => []);
  const match = files.find((name) => name.startsWith(videoId) && name.endsWith(".vtt"));
  if (!match) return null;
  return readFile(path.join(cacheDir, match), "utf8");
}

/**
 * Возвращает VTT субтитров для видео (из кэша или скачивает).
 * @param {string} urlOrId ссылка YouTube или id
 * @param {{ cacheDir: string, lang?: string, force?: boolean }} options
 */
export async function fetchSubtitles(urlOrId, options) {
  const videoId = parseYouTubeId(urlOrId);
  if (!videoId) throw new Error("не удалось понять ссылку YouTube");

  const cacheDir = options.cacheDir;
  await mkdir(cacheDir, { recursive: true });

  if (!options.force) {
    const cached = await findCached(cacheDir, videoId);
    if (cached) return { videoId, vtt: cached, cached: true };
  }

  const lang = options.lang || "ru";
  const { code, stderr } = await runYtDlp([
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    `${lang}.*,${lang},en.*,en`,
    "--sub-format",
    "vtt",
    "--no-playlist",
    "-o",
    path.join(cacheDir, "%(id)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  const downloaded = await findCached(cacheDir, videoId);
  if (!downloaded) {
    const hint = stderr.split("\n").filter(Boolean).slice(-3).join(" ");
    throw new Error(`не удалось получить субтитры (код ${code}): ${hint || "нет ответа yt-dlp"}`);
  }
  return { videoId, vtt: downloaded, cached: false };
}

export default { fetchSubtitles, ytdlpAvailable };
