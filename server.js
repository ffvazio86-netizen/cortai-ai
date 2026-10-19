import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.CORTAI_DATA_DIR || path.join(__dirname, "data"));
const OUTPUT_DIR = path.join(DATA_DIR, "cuts");
const TEMP_DIR = path.join(DATA_DIR, "temp");
const jobs = new Map();
const MAX_ACTIVE_JOBS = 1;
const MAX_STORAGE_BYTES = Number(process.env.CORTAI_MAX_STORAGE_BYTES || 5 * 1024 * 1024 * 1024);
const RESERVED_JOB_BYTES = Number(process.env.CORTAI_RESERVED_JOB_BYTES || 1024 * 1024 * 1024);
const OUTPUT_RETENTION_MS = Number(process.env.CORTAI_OUTPUT_RETENTION_MS || 24 * 60 * 60 * 1000);
const MAX_RETAINED_JOBS = 500;
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

async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(fullPath);
    else if (entry.isFile()) total += (await stat(fullPath)).size;
  }
  return total;
}

async function enforceStorageLimit() {
  const now = Date.now();
  const dirs = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const fullPath = path.join(OUTPUT_DIR, dir.name);
    const details = await stat(fullPath).catch(() => null);
    if (details && now - details.mtimeMs > OUTPUT_RETENTION_MS) {
      await rm(fullPath, { recursive: true, force: true });
      jobs.delete(dir.name);
    }
  }
  const used = await directorySize(DATA_DIR);
  if (used + RESERVED_JOB_BYTES > MAX_STORAGE_BYTES) {
    const error = new Error("O armazenamento de cortes está cheio. Os arquivos antigos são removidos automaticamente; tente novamente mais tarde.");
    error.statusCode = 507;
    throw error;
  }
}

function pruneJobHistory() {
  while (jobs.size > MAX_RETAINED_JOBS) {
    const oldest = jobs.keys().next().value;
    if (!oldest) break;
    const item = jobs.get(oldest);
    if (item && (item.status === "queued" || item.status === "processing")) break;
    jobs.delete(oldest);
  }
}

function run(command, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-12000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on("error", () => { clearTimeout(timer); reject(new Error(`Não foi possível executar ${command}. Verifique se está instalado.`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(stderr.trim().split("\n").slice(-4).join(" ").slice(0, 700) || `${command} terminou com código ${code}`);
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      }
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
    await enforceStorageLimit();
    job.status = "processing";
    job.message = "Verificando ferramentas de vídeo…";
    await findBinary("ffmpeg", ["-version"]);
    await findBinary("ffprobe", ["-version"]);

    let videoPath;
    if (job.uploadedPath) {
      videoPath = job.uploadedPath;
      job.message = "Validando o vídeo enviado…";
    } else {
      await findBinary("yt-dlp");
      job.message = "Obtendo o vídeo autorizado…";
      const inputPath = path.join(source, "source.%(ext)s");
      try {
        await run("yt-dlp", [
          "--no-playlist", "--no-progress", "--verbose", "--max-filesize", "2G",
          "--force-ipv4", "--retries", "3", "--fragment-retries", "3",
          "--extractor-retries", "3", "--retry-sleep", "http:2",
          "--remote-components", "ejs:github",
          "--extractor-args", "youtube:player_client=mweb",
          "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
          "-f", "bv*+ba/b", "--merge-output-format", "mp4",
          "-o", inputPath, job.url
        ]);
      } catch (error) {
        const details = error.message || "";
        if (error.stderr) console.error("[Cort-AI] Diagnóstico yt-dlp:", error.stderr.slice(-12000));
        if (/HTTP Error 429|Too Many Requests/i.test(details)) {
          throw new Error("O YouTube limitou os downloads deste servidor (HTTP 429). Aguarde antes de tentar novamente. Se continuar, baixe o vídeo que você tem autorização para usar e envie o arquivo pelo formulário; o bloqueio por IP é controlado pelo YouTube e não pode ser removido apenas pelo Cort-AI.");
        }
        if (/HTTP Error 403|Forbidden|Unable to download API page|Sign in to confirm/i.test(details)) {
          throw new Error("O YouTube recusou o download (HTTP 403). Isso pode ocorrer por validação de segurança, formato indisponível ou restrição do servidor. O Cort-AI tentou usar IPv4 e o provedor de token PO Token; isso não garante que o YouTube permita o download. Se o erro persistir, envie um arquivo de vídeo que você tenha autorização para processar.");
        }
        throw error;
      }
      const files = await readdir(source);
      const videoName = files.find(name => /^source\./.test(name) && !name.endsWith(".part"));
      if (!videoName) throw new Error("Não foi possível localizar o vídeo baixado. Verifique se o link está público e acessível.");
      videoPath = path.join(source, videoName);
    }
    await enforceStorageLimit();

    job.message = "Analisando duração do vídeo…";
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration < 180) throw new Error("Para criar 3 cortes de pelo menos 1 minuto, o vídeo precisa ter no mínimo 3 minutos.");
    const clipLength = Math.min(300, Math.floor(duration / 3));
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
      await enforceStorageLimit();
      job.progress = Math.round(((i + 1) / 3) * 100);
    }
    job.cuts = cuts;
    job.status = "done";
    job.message = "Seus 3 cortes estão prontos.";
  } catch (error) {
    await rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(source, { recursive: true, force: true }).catch(() => {});
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Cort-AI", version: "1.0.0" }));

app.post("/api/upload", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (req, res) => {
  const authorized = req.query?.authorized === "true";
  const filename = typeof req.query?.filename === "string" ? path.basename(req.query.filename) : "";
  const extension = path.extname(filename).toLowerCase();
  if (!authorized) return res.status(400).json({ error: "Confirme que você tem autorização para processar este vídeo." });
  if (![".mp4", ".mov", ".webm", ".mkv"].includes(extension)) {
    return res.status(400).json({ error: "Envie um arquivo MP4, MOV, WebM ou MKV." });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "O arquivo enviado está vazio ou não foi recebido." });
  }
  if (activeJobs >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: "Já existe um vídeo sendo processado. Tente novamente em alguns minutos." });
  activeJobs++;
  let source;
  try {
    await enforceStorageLimit();
    const id = randomUUID();
    source = path.join(TEMP_DIR, id);
    await mkdir(source, { recursive: true });
    const uploadedPath = path.join(source, `uploaded${extension}`);
    await writeFile(uploadedPath, req.body, { flag: "wx" });
    const job = { id, uploadedPath, status: "queued", progress: 0, message: "Preparando o vídeo enviado…", cuts: [] };
    jobs.set(id, job);
    pruneJobHistory();
    res.status(202).json({ jobId: id, status: job.status });
    createCuts(job)
      .catch(error => { job.status = "error"; job.message = error.message || "Falha ao gerar os cortes."; })
      .finally(() => { activeJobs = Math.max(0, activeJobs - 1); });
  } catch (error) {
    activeJobs = Math.max(0, activeJobs - 1);
    if (source) await rm(source, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) res.status(error.statusCode || 500).json({ error: error.message || "Não foi possível receber o vídeo." });
  }
});

app.post("/api/cuts", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!validVideoUrl(url)) return res.status(400).json({ error: "Cole um link válido do YouTube ou da Twitch." });
  if (req.body?.authorized !== true) return res.status(400).json({ error: "Confirme que você tem autorização para processar este vídeo." });
  if (activeJobs >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: "Já existe um vídeo sendo processado. Tente novamente em alguns minutos." });
  activeJobs++;
  try {
    await enforceStorageLimit();
  } catch (error) {
    activeJobs = Math.max(0, activeJobs - 1);
    return res.status(error.statusCode || 500).json({ error: error.message || "Não foi possível verificar o armazenamento." });
  }
  const job = { id: randomUUID(), url, status: "queued", progress: 0, message: "Preparando processamento…", cuts: [] };
  jobs.set(job.id, job);
  pruneJobHistory();
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

export { app, validVideoUrl };

const isMainModule = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) app.listen(PORT, () => console.log(`Cort-AI disponível na porta ${PORT}`));
