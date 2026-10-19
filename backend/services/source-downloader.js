const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
  "twitch.tv", "www.twitch.tv", "m.twitch.tv", "clips.twitch.tv"
]);

function validateSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw Object.assign(new Error("Cole um link válido do YouTube ou Twitch."), { code: "INVALID_SOURCE_URL" });
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw Object.assign(new Error("Cole um link válido do YouTube ou Twitch."), { code: "INVALID_SOURCE_URL" }); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.port || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw Object.assign(new Error("Use um link HTTPS público do YouTube ou Twitch."), { code: "INVALID_SOURCE_URL" });
  }
  if (parsed.hostname.toLowerCase().includes("youtube.com") &&
      !["/watch", "/live", "/shorts", "/embed"].some(prefix => parsed.pathname === prefix || parsed.pathname.startsWith(prefix + "/")) &&
      parsed.hostname.toLowerCase() !== "youtube.com") {
    throw Object.assign(new Error("Esse formato de link do YouTube não é compatível."), { code: "INVALID_SOURCE_URL" });
  }
  return parsed.toString();
}

function downloadSourceVideo({ url, outputPath, timeoutMs = 5 * 60 * 1000 }) {
  const safeUrl = validateSourceUrl(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let timer;
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    try {
      child = spawn("yt-dlp", [
        "--no-playlist", "--no-warnings", "--no-progress", "--no-part",
        "--restrict-filenames", "--socket-timeout", "15",
        "--retries", "1", "--fragment-retries", "1",
        "--max-filesize", String(MAX_SOURCE_BYTES),
        "--match-filter", "duration > 299",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "-o", outputPath,
        "--", safeUrl
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return finish(error);
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Object.assign(new Error("O download excedeu o tempo limite. Tente um vídeo menor."), { code: "SOURCE_DOWNLOAD_TIMEOUT" }));
    }, timeoutMs);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.on("error", error => {
      if (error.code === "ENOENT") {
        return finish(Object.assign(new Error("O serviço de download não está instalado neste servidor."), { code: "SOURCE_DOWNLOADER_UNAVAILABLE" }));
      }
      finish(error);
    });
    child.on("close", async code => {
      if (code !== 0) {
        const message = /File is larger than|maximum file size/i.test(stderr)
          ? "O vídeo ultrapassa o limite de 100 MB."
          : /duration|match filter/i.test(stderr)
            ? "Escolha um vídeo público com mais de 5 minutos."
            : "Não foi possível obter esse vídeo. Confirme se o link é público e tente outro.";
        return finish(Object.assign(new Error(message), { code: "SOURCE_DOWNLOAD_FAILED", details: stderr }));
      }
      try {
        const stats = await fs.stat(outputPath);
        if (!stats.isFile() || stats.size < 1024 || stats.size > MAX_SOURCE_BYTES) {
          await fs.unlink(outputPath).catch(() => {});
          return finish(Object.assign(new Error("O vídeo baixado está vazio ou ultrapassa 100 MB."), { code: "SOURCE_SIZE_LIMIT" }));
        }
        finish();
      } catch {
        finish(Object.assign(new Error("O vídeo não foi encontrado após o download."), { code: "SOURCE_DOWNLOAD_FAILED" }));
      }
    });
  });
}

module.exports = { downloadSourceVideo, validateSourceUrl, MAX_SOURCE_BYTES };
