const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function extractAudio(inputPath, outputPath, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    let child;
    try {
      child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000",
        "-b:a", "48k", "-f", "mp3", "-y", outputPath
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return finish(error);
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Object.assign(new Error("A extração do áudio excedeu o tempo limite."), { code: "AUDIO_EXTRACTION_TIMEOUT" }));
    }, timeoutMs);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", finish);
    child.on("close", code => {
      if (code === 0) return finish();
      finish(Object.assign(new Error("Não foi possível extrair o áudio do vídeo."), { code: "AUDIO_EXTRACTION_FAILED", details: stderr }));
    });
  });
}

async function transcribeAudio({ inputPath, audioPath, apiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw Object.assign(new Error("A integração com a IA ainda não está configurada."), { code: "AI_NOT_CONFIGURED" });
  }
  await extractAudio(inputPath, audioPath);
  const stats = await fs.stat(audioPath);
  if (!stats.size) {
    throw Object.assign(new Error("O vídeo não contém áudio utilizável."), { code: "NO_AUDIO_TRACK" });
  }
  if (stats.size > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error("O áudio é grande demais para transcrição em uma única etapa. Use um vídeo mais curto."), { code: "AUDIO_TOO_LARGE" });
  }

  const bytes = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(audioPath));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetchImpl(TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!response.ok) {
    const error = Object.assign(new Error(
      response.status === 401 || response.status === 403
        ? "A chave ou as permissões da API OpenAI foram recusadas."
        : response.status === 429
          ? "Limite de uso da OpenAI atingido. Verifique faturamento e limites da API."
          : "Não foi possível transcrever o áudio agora."
    ), { code: response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_ERROR", status: response.status });
    throw error;
  }

  const payload = await response.json();
  if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
    throw Object.assign(new Error("Não foi possível identificar fala no áudio."), { code: "TRANSCRIPTION_EMPTY" });
  }
  return payload.segments.slice(0, 500).map(segment => ({
    startSeconds: Number(segment.start),
    endSeconds: Number(segment.end),
    text: String(segment.text || "").trim()
  })).filter(segment => segment.text && Number.isFinite(segment.startSeconds) &&
    Number.isFinite(segment.endSeconds) && segment.startSeconds >= 0 &&
    segment.endSeconds > segment.startSeconds);
}

module.exports = { transcribeAudio, extractAudio, MAX_AUDIO_BYTES };
