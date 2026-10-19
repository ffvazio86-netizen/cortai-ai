import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.CORTAI_DATA_DIR || path.join(__dirname, "data"));
const OUTPUT_DIR = path.join(DATA_DIR, "cuts");
const TEMP_DIR = path.join(DATA_DIR, "temp");
const jobs = new Map();
const MAX_ACTIVE_JOBS = 1;
let activeJobs = 0;

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/cuts", express.static(OUTPUT_DIR, { fallthrough: false, index: false, maxAge: "1h" }));

function validVideoUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "twitch.tv" || host === "m.twitch.tv" || host === "clips.twitch.tv") return true;
    return false;
  } catch { return false; }
}

function run(command, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-12000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on("error", error => { clearTimeout(timer); reject(new Error(`Não foi possível executar ${command}. Verifique se está instalado.`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().split("\n").slice(-4).join(" ").slice(-700) || `${command} terminou com código ${code}`));
    });
  });
}

async function findBinary(name, versionArgs = ["--version"]) {
  await run(name, versionArgs, { timeoutMs: 10000 });
}

async function createCuts(job) {
  const source = path.join(TEMP_DIR, job.id);
  await mkdir(source, { recursive: true });
  const output = path.join(OUTPUT_DIR, job.id);
  await mkdir(output, { recursive: true });
  try {
    job.status = "processing";
    job.message = "Verificando ferramentas de vídeo…";
    await findBinary("yt-dlp");
    await findBinary("ffmpeg");
    await findBinary("ffprobe");

    job.message = "Obtendo o vídeo autorizado…";
    const inputPath = path.join(source, "source.%(ext)s");
    await run("yt-dlp", [
      "--no-playlist", "--no-progress", "--max-filesize", "2G",
      "-f", "bv*+ba/b", "--merge-output-format", "mp4",
      "-o", inputPath, job.url
    ]);
    const files = await readdir(source);
    const videoName = files.find(name => /^source\./.test(name) && !name.endsWith(".part"));
    if (!videoName) throw new Error("Não foi possível localizar o vídeo baixado. Verifique se o link está público e acessível.");
    const videoPath = path.join(source, videoName);

    job.message = "Analisando duração do vídeo…";
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration < 180) throw new Error("Para criar 3 cortes de pelo menos 1 minuto, o vídeo precisa ter no mínimo 3 minutos.");
    const clipLength = Math.min(180, 300, Math.floor(duration / 3));
    if (clipLength < 60) throw new Error("Não foi possível selecionar um trecho de pelo menos 1 minuto.");

    // MVP: três trechos distribuídos pelo vídeo. A seleção semântica de melhores momentos
    // será uma etapa posterior; esta versão prioriza validar o fluxo real de geração.
    const maxStart = Math.max(0, duration - clipLength);
    const starts = [maxStart * 0.15, maxStart * 0.5, maxStart * 0.8].map(Math.floor);
    job.message = "Gerando 3 cortes verticais sem legendas…";
    const cuts = [];
    for (let i = 0; i < starts.length; i++) {
      const fileName = `corte-${i + 1}.mp4`;
      const target = path.join(output, fileName);
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(starts[i]),
        "-i", videoPath, "-t", String(clipLength),
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", target
      ]);
      cuts.push({ name: fileName, url: `/cuts/${job.id}/${fileName}`, durationSeconds: clipLength, startSeconds: starts[i] });
      job.progress = Math.round(((i + 1) / 3) * 100);
    }
    job.cuts = cuts;
    job.status = "done";
    job.message = "Seus 3 cortes estão prontos.";
  } finally {
    await rm(source, { recursive: true, force: true }).catch(() => {});
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Cort-AI", version: "1.0.0" }));

app.post("/api/cuts", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!validVideoUrl(url)) return res.status(400).json({ error: "Cole um link válido do YouTube ou da Twitch." });
  if (req.body?.authorized !== true) return res.status(400).json({ error: "Confirme que você tem autorização para processar este vídeo." });
  if (activeJobs >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: "Já existe um vídeo sendo processado. Tente novamente em alguns minutos." });
  const job = { id: randomUUID(), url, status: "queued", progress: 0, message: "Preparando processamento…", cuts: [] };
  jobs.set(job.id, job);
  activeJobs++;
  res.status(202).json({ jobId: job.id, status: job.status });
  createCuts(job)
    .catch(error => { job.status = "error"; job.message = error.message || "Falha ao gerar os cortes."; })
    .finally(() => { activeJobs = Math.max(0, activeJobs - 1); });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Processamento não encontrado. Envie o link novamente." });
  res.json({ id: job.id, status: job.status, progress: job.progress || 0, message: job.message, cuts: job.cuts || [] });
});

await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(TEMP_DIR, { recursive: true });
app.listen(PORT, () => console.log(`Cort-AI disponível na porta ${PORT}`));
