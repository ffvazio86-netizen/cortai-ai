const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { getFfmpegInfo } = require("./services/ffmpeg");
const { probeVideo } = require("./services/video-validation");
const { generateVideoCut } = require("./services/video-cut");
const { findUploadedVideo, UUID_PATTERN } = require("./services/video-files");
const { suggestHighlights } = require("./services/ai-highlight-suggestions");
const { transcribeAudio } = require("./services/audio-transcription");
const { downloadSourceVideo, validateSourceUrl, MAX_SOURCE_BYTES } = require("./services/source-downloader");
const { cleanupExpiredFiles, getStorageUsage } = require("./services/video-storage");
const auth = require("./auth");

const app = express();
app.disable("x-powered-by");
// Configure TRUST_PROXY=1 only when deployed behind Render's single proxy.
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
// Cross-origin frontend access is opt-in and restricted to one exact origin.
function corsForConfiguredFrontend(req, res, next) {
  const origin = req.get("origin");
  const configuredOrigin = process.env.CORTAI_ALLOWED_ORIGIN || process.env.CORTAI_PUBLIC_ORIGIN;
  if (!origin) {
    if (req.method === "OPTIONS") return res.status(403).json({ error: "origin_not_allowed" });
    return next();
  }
  let allowedOrigin;
  try {
    allowedOrigin = configuredOrigin ? new URL(configuredOrigin).origin : null;
  } catch {
    return res.status(500).json({ error: "cors_origin_misconfigured" });
  }
  if (!allowedOrigin || origin !== allowedOrigin) {
    if (req.method === "OPTIONS" || configuredOrigin) {
      return res.status(403).json({ error: "origin_not_allowed" });
    }
    return next();
  }
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }
  return next();
}
app.use(corsForConfiguredFrontend);
app.use(express.json({ limit: "100kb" }));

const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "upload_rate_limit",
    message: "Limite de envios atingido. Tente novamente em 15 minutos."
  }
});

const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "ai_rate_limit",
    message: "Limite de análises de IA atingido. Tente novamente em 15 minutos."
  }
});

const cutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "cut_rate_limit",
    message: "Limite de cortes atingido. Tente novamente em 15 minutos."
  }
});

const uploadDirectory = path.resolve(
  process.env.CORTAI_STORAGE_DIR || path.join(os.tmpdir(), "cortai-ai-uploads")
);
fs.mkdirSync(uploadDirectory, { recursive: true });

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_CUT_BYTES = 100 * 1024 * 1024;
const CUT_DURATION_TOLERANCE_SECONDS = 0.25;

function parseIntegerSetting(value, fallback, min, max, settingName) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    console.warn(
      `Configuração ${settingName} inválida; usando o valor padrão seguro (${fallback}).`
    );
    return fallback;
  }

  return parsed;
}

function isCutDurationValid(actualDuration, requestedDuration) {
  return Number.isFinite(actualDuration) && actualDuration > 0 &&
    actualDuration >= requestedDuration - CUT_DURATION_TOLERANCE_SECONDS &&
    actualDuration <= requestedDuration + CUT_DURATION_TOLERANCE_SECONDS;
}

const maxStorageMb = parseIntegerSetting(
  process.env.CORTAI_MAX_STORAGE_MB, 500, 100, 102400, "CORTAI_MAX_STORAGE_MB"
);
const maxStorageBytes = maxStorageMb * 1024 * 1024;
const fileTtlHours = parseIntegerSetting(
  process.env.CORTAI_FILE_TTL_HOURS, 2, 1, 720, "CORTAI_FILE_TTL_HOURS"
);
const fileTtlMs = fileTtlHours * 60 * 60 * 1000;
let pendingUploadBytes = 0;
let pendingCutBytes = 0;

async function cleanupStorage() {
  const removed = await cleanupExpiredFiles(uploadDirectory, fileTtlMs);
  if (removed > 0) console.log(`Limpeza do Cort-AI: ${removed} arquivo(s) expirado(s) removido(s).`);
}

const cleanupTimer = setInterval(() => {
  cleanupStorage().catch((error) => console.error("Falha na limpeza do armazenamento:", error.message));
}, 10 * 60 * 1000);
cleanupTimer.unref();
cleanupStorage().catch((error) => console.error("Falha na limpeza inicial:", error.message));

const allowedVideoTypes = new Map([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["video/x-matroska", ".mkv"]
]);

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => {
      const extension = allowedVideoTypes.get(file.mimetype);
      callback(null, `${randomUUID()}${extension}`);
    }
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedVideoTypes.has(file.mimetype)) {
      const error = new Error("Formato de vídeo não suportado.");
      error.code = "UNSUPPORTED_VIDEO_FORMAT";
      return callback(error);
    }
    callback(null, true);
  }
});

auth.registerRoutes(app, rateLimit);

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

app.get("/api/health", async (_req, res) => {
  const ffmpeg = await getFfmpegInfo();
  res.status(200).json({
    status: ffmpeg.available ? "ok" : "degraded",
    service: "cortai-ai-backend",
    timestamp: new Date().toISOString(),
    ffmpeg
  });
});

app.post("/api/ai/suggest-highlights", auth.authenticate, aiRateLimit, async (req, res) => {
  const { videoDurationSeconds, transcriptSegments } = req.body || {};
  if (!Number.isFinite(videoDurationSeconds) || !Array.isArray(transcriptSegments)) {
    return res.status(400).json({
      error: "invalid_ai_input",
      message: "Informe videoDurationSeconds e transcriptSegments válidos."
    });
  }

  try {
    const cuts = await suggestHighlights({
      durationSeconds: videoDurationSeconds,
      segments: transcriptSegments
    });
    return res.status(200).json({
      message: "Sugestões de melhores momentos geradas.",
      cuts
    });
  } catch (error) {
    if (error.code === "AI_NOT_CONFIGURED") {
      return res.status(503).json({
        error: error.code,
        message: "A IA ainda não está configurada no backend."
      });
    }
    if (["INVALID_VIDEO_DURATION", "INVALID_TRANSCRIPT", "TRANSCRIPT_TOO_LONG"].includes(error.code)) {
      return res.status(400).json({ error: error.code, message: error.message });
    }
    if (error.code === "AI_RATE_LIMITED") {
      return res.status(429).json({ error: error.code, message: error.message });
    }
    if (error.code === "AI_PROVIDER_ERROR" && error.status === 401) {
      return res.status(503).json({
        error: "AI_CONFIGURATION_ERROR",
        message: "A chave ou as permissões da API OpenAI foram recusadas."
      });
    }
    console.error("Falha ao sugerir melhores momentos:", error.code || "AI_ERROR");
    return res.status(502).json({
      error: error.code || "AI_PROVIDER_ERROR",
      message: error.message || "Não foi possível analisar a transcrição agora."
    });
  }
});

app.post("/api/videos/:videoId/transcribe", auth.authenticate, aiRateLimit, async (req, res) => {
  const { videoId } = req.params;
  if (!UUID_PATTERN.test(videoId)) {
    return res.status(400).json({ error: "invalid_video_id", message: "O ID do vídeo é inválido." });
  }
  try {
    if (!auth.ownsResource(req.user?.id, videoId, "video")) {
      return res.status(404).json({ error: "video_not_found", message: "Vídeo não encontrado." });
    }
  } catch (error) {
    console.error("Falha ao verificar propriedade do vídeo:", error.message);
    return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível verificar a propriedade do vídeo." });
  }

  let inputPath;
  const audioPath = path.join(uploadDirectory, `${randomUUID()}.mp3`);
  try {
    inputPath = await findUploadedVideo(uploadDirectory, videoId);
    if (!inputPath) {
      return res.status(404).json({ error: "video_not_found", message: "Envie o vídeo novamente antes de transcrever." });
    }
    const segments = await transcribeAudio({ inputPath, audioPath });
    const source = await probeVideo(inputPath);
    if (!source.valid) {
      return res.status(422).json({ error: "invalid_video", message: "O vídeo original não pode ser processado." });
    }
    return res.status(200).json({
      message: "Transcrição concluída.",
      videoDurationSeconds: source.duration,
      transcriptSegments: segments
    });
  } catch (error) {
    if (error.code === "AI_NOT_CONFIGURED") {
      return res.status(503).json({ error: error.code, message: "A IA ainda não está configurada no backend." });
    }
    if (["AUDIO_EXTRACTION_TIMEOUT", "AUDIO_EXTRACTION_FAILED", "NO_AUDIO_TRACK", "AUDIO_TOO_LARGE"].includes(error.code)) {
      return res.status(error.code === "AUDIO_EXTRACTION_TIMEOUT" ? 504 : 422).json({ error: error.code, message: error.message });
    }
    if (error.code === "AI_RATE_LIMITED") {
      return res.status(429).json({ error: error.code, message: error.message });
    }
    if (error.code === "AI_PROVIDER_ERROR" && (error.status === 401 || error.status === 403)) {
      return res.status(503).json({ error: "AI_CONFIGURATION_ERROR", message: "A chave ou as permissões da API OpenAI foram recusadas." });
    }
    console.error("Falha ao transcrever vídeo:", error.code || "TRANSCRIPTION_ERROR");
    return res.status(502).json({ error: error.code || "TRANSCRIPTION_ERROR", message: error.message || "Não foi possível transcrever o vídeo agora." });
  } finally {
    await fs.promises.unlink(audioPath).catch(() => {});
  }
});

app.post("/api/videos/from-url", auth.authenticate, uploadRateLimit, async (req, res) => {
  let sourceUrl;
  try {
    sourceUrl = validateSourceUrl(req.body?.url);
  } catch (error) {
    return res.status(400).json({ error: error.code || "invalid_source_url", message: error.message });
  }

  const videoId = randomUUID();
  const outputPath = path.join(uploadDirectory, `${videoId}.mp4`);
  let reserved = false;
  try {
    await cleanupStorage();
    const currentUsage = await getStorageUsage(uploadDirectory);
    if (currentUsage + pendingUploadBytes + pendingCutBytes + MAX_UPLOAD_BYTES > maxStorageBytes) {
      return res.status(507).json({
        error: "storage_limit_reached",
        message: "O armazenamento temporário está cheio. Tente novamente mais tarde."
      });
    }
    pendingUploadBytes += MAX_UPLOAD_BYTES;
    reserved = true;

    await downloadSourceVideo({ url: sourceUrl, outputPath });
    const validation = await probeVideo(outputPath);
    if (validation.unavailable) {
      await fs.promises.unlink(outputPath).catch(() => {});
      return res.status(503).json({
        error: "video_validation_unavailable",
        message: "A validação de vídeo está indisponível neste servidor."
      });
    }
    if (!validation.valid || validation.duration <= 299) {
      await fs.promises.unlink(outputPath).catch(() => {});
      return res.status(422).json({
        error: "invalid_source_video",
        message: "Escolha um vídeo público válido com mais de 5 minutos."
      });
    }
    const stats = await fs.promises.stat(outputPath);
    if (stats.size > MAX_SOURCE_BYTES) {
      return res.status(413).json({ error: "source_size_limit", message: "O vídeo ultrapassa o limite de 100 MB." });
    }
    auth.recordResource(req.user?.id, videoId, "video");
    return res.status(201).json({
      message: "Vídeo obtido. Pronto para transcrição e análise.",
      video: {
        id: videoId,
        originalName: "video-fonte.mp4",
        size: stats.size,
        mimeType: "video/mp4",
        durationSeconds: validation.duration,
        sourceUrl
      }
    });
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    if (error.code === "SOURCE_DOWNLOADER_UNAVAILABLE") {
      return res.status(503).json({ error: error.code, message: error.message });
    }
    if (error.code === "SOURCE_DOWNLOAD_TIMEOUT") {
      return res.status(504).json({ error: error.code, message: error.message });
    }
    if (error.code === "SOURCE_SIZE_LIMIT") {
      return res.status(413).json({ error: error.code, message: error.message });
    }
    if (error.code === "SOURCE_DOWNLOAD_FAILED") {
      console.warn("Falha ao obter vídeo da origem:", error.details || error.message);
      return res.status(422).json({ error: error.code, message: error.message });
    }
    if (error.code === "AUTH_NOT_CONFIGURED" || error.code === "AUTH_STORAGE_UNAVAILABLE") {
      return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível associar o vídeo à conta." });
    }
    console.error("Falha no processamento do link:", error.message);
    return res.status(500).json({ error: "source_processing_failed", message: "Não foi possível preparar esse vídeo agora." });
  } finally {
    if (reserved) pendingUploadBytes = Math.max(0, pendingUploadBytes - MAX_UPLOAD_BYTES);
  }
});

app.post("/api/videos", auth.authenticate, uploadRateLimit, async (req, res, next) => {
  try {
    await cleanupStorage();
    const currentUsage = await getStorageUsage(uploadDirectory);
    // Reserve the maximum upload size before Multer writes the file, avoiding
    // concurrent requests exceeding the configured quota.
    if (currentUsage + pendingUploadBytes + pendingCutBytes + MAX_UPLOAD_BYTES > maxStorageBytes) {
      return res.status(507).json({
        error: "storage_limit_reached",
        message: "O armazenamento temporário está cheio. Tente novamente mais tarde."
      });
    }
    pendingUploadBytes += MAX_UPLOAD_BYTES;
  } catch (storageError) {
    return next(storageError);
  }

  videoUpload.single("video")(req, res, async (error) => {
    pendingUploadBytes = Math.max(0, pendingUploadBytes - MAX_UPLOAD_BYTES);
    if (error) return next(error);
    if (!req.file) {
      return res.status(400).json({
        error: "video_required",
        message: "Envie um arquivo no campo 'video'."
      });
    }

    try {
      const validation = await probeVideo(req.file.path);
      if (validation.unavailable) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(503).json({
          error: "video_validation_unavailable",
          message: "A validação de vídeo está indisponível neste servidor."
        });
      }
      if (!validation.valid) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(422).json({
          error: "invalid_video",
          message: "O arquivo não contém um vídeo válido ou está corrompido."
        });
      }

      const videoId = path.basename(req.file.filename, path.extname(req.file.filename));
      try {
        auth.recordResource(req.user?.id, videoId, "video");
      } catch (ownershipError) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return next(ownershipError);
      }
      return res.status(201).json({
        message: "Vídeo válido recebido para a próxima etapa de processamento.",
        video: {
          id: videoId,
          originalName: path.basename(req.file.originalname),
          size: req.file.size,
          mimeType: req.file.mimetype,
          durationSeconds: validation.duration
        }
      });
    } catch (validationError) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return next(validationError);
    }
  });
});

app.post("/api/videos/:videoId/cuts", auth.authenticate, cutRateLimit, async (req, res) => {
  const { videoId } = req.params;
  if (!UUID_PATTERN.test(videoId)) {
    return res.status(400).json({
      error: "invalid_video_id",
      message: "O ID do vídeo é inválido."
    });
  }

  try {
    if (!auth.ownsResource(req.user?.id, videoId, "video")) {
      return res.status(404).json({ error: "video_not_found", message: "Vídeo não encontrado." });
    }
  } catch (error) {
    console.error("Falha ao verificar propriedade do vídeo:", error.message);
    return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível verificar a propriedade do vídeo." });
  }

  const { startSeconds, durationSeconds } = req.body || {};
  if (
    typeof startSeconds !== "number" ||
    !Number.isFinite(startSeconds) ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    startSeconds < 0 ||
    durationSeconds < 61 ||
    durationSeconds > 299
  ) {
    return res.status(400).json({
      error: "invalid_cut_parameters",
      message: "Informe startSeconds >= 0 e durationSeconds entre 61 e 299 segundos."
    });
  }

  let inputPath;
  let cutReservation = false;
  try {
    await cleanupStorage();
    const currentUsage = await getStorageUsage(uploadDirectory);
    if (currentUsage + pendingUploadBytes + pendingCutBytes + MAX_CUT_BYTES > maxStorageBytes) {
      return res.status(507).json({
        error: "storage_limit_reached",
        message: "Não há espaço temporário suficiente para gerar outro corte."
      });
    }
    pendingCutBytes += MAX_CUT_BYTES;
    cutReservation = true;

    inputPath = await findUploadedVideo(uploadDirectory, videoId);
    if (!inputPath) {
      return res.status(404).json({
        error: "video_not_found",
        message: "Vídeo não encontrado. Envie o vídeo novamente antes de gerar um corte."
      });
    }

    const source = await probeVideo(inputPath);
    if (source.unavailable) {
      return res.status(503).json({
        error: "video_validation_unavailable",
        message: "A validação de vídeo está indisponível neste servidor."
      });
    }
    if (!source.valid) {
      return res.status(422).json({
        error: "invalid_video",
        message: "O vídeo original não pode ser processado."
      });
    }
    if (startSeconds >= source.duration || startSeconds + durationSeconds > source.duration + 0.05) {
      return res.status(400).json({
        error: "cut_out_of_bounds",
        message: "O início e a duração do corte devem ficar dentro do vídeo original."
      });
    }

    const cutId = randomUUID();
    const outputPath = path.join(uploadDirectory, `${cutId}.mp4`);
    try {
      await generateVideoCut(inputPath, outputPath, startSeconds, durationSeconds, 180000, MAX_CUT_BYTES);
      const outputStats = await fs.promises.stat(outputPath);
      if (outputStats.size > MAX_CUT_BYTES) {
        throw Object.assign(new Error("Generated cut exceeded the reserved storage size."), { code: "CUT_SIZE_LIMIT" });
      }
      const output = await probeVideo(outputPath);
      if (!output.valid) {
        throw Object.assign(new Error("Generated cut failed validation."), { code: "FFMPEG_CUT_FAILED" });
      }
      if (!isCutDurationValid(output.duration, durationSeconds)) {
        throw Object.assign(new Error("Generated cut duration does not match the requested duration."), {
          code: "CUT_DURATION_MISMATCH"
        });
      }
      try {
        auth.recordResource(req.user?.id, cutId, "cut");
      } catch (ownershipError) {
        await fs.promises.unlink(outputPath).catch(() => {});
        throw ownershipError;
      }
      return res.status(201).json({
        message: "Corte gerado com sucesso.",
        cut: {
          id: cutId,
          videoId,
          startSeconds,
          durationSeconds: output.duration,
          format: "mp4",
          downloadUrl: `/api/cuts/${cutId}/download`,
          streamUrl: `/api/cuts/${cutId}/stream`
        }
      });
    } catch (error) {
      await fs.promises.unlink(outputPath).catch(() => {});
      if (error.code === "FFMPEG_TIMEOUT") {
        return res.status(504).json({
          error: "cut_timeout",
          message: "A geração do corte excedeu o tempo limite."
        });
      }
      if (error.code === "CUT_SIZE_LIMIT") {
        return res.status(507).json({
          error: "storage_limit_reached",
          message: "O corte excedeu o limite de armazenamento permitido."
        });
      }
      if (error.code === "FFMPEG_CUT_FAILED" || error.code === "CUT_DURATION_MISMATCH" || error.code === "ENOENT") {
        return res.status(422).json({
          error: "cut_failed",
          message: "Não foi possível gerar o corte. Verifique se o FFmpeg está disponível."
        });
      }
      throw error;
    }
  } catch (error) {
    console.error("Erro ao gerar corte:", error.message);
    return res.status(500).json({
      error: "internal_server_error",
      message: "Ocorreu um erro interno ao gerar o corte."
    });
  } finally {
    if (cutReservation) {
      pendingCutBytes = Math.max(0, pendingCutBytes - MAX_CUT_BYTES);
    }
  }
});

app.get("/api/cuts/:cutId/stream", auth.authenticate, async (req, res) => {
  const { cutId } = req.params;
  if (!UUID_PATTERN.test(cutId)) {
    return res.status(400).json({
      error: "invalid_cut_id",
      message: "O ID do corte é inválido."
    });
  }

  try {
    if (!auth.ownsResource(req.user?.id, cutId, "cut")) {
      return res.status(404).json({ error: "cut_not_found", message: "Corte não encontrado." });
    }
  } catch (error) {
    console.error("Falha ao verificar propriedade do corte:", error.message);
    return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível verificar a propriedade do corte." });
  }

  const cutPath = path.join(uploadDirectory, `${cutId}.mp4`);
  try {
    await fs.promises.access(cutPath, fs.constants.R_OK);
    res.setHeader("Cache-Control", "private, no-store");
    return res.sendFile(cutPath, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "inline"
      }
    });
  } catch {
    return res.status(404).json({
      error: "cut_not_found",
      message: "Corte não encontrado. Gere o corte novamente."
    });
  }
});

app.get("/api/cuts/:cutId/download", auth.authenticate, async (req, res) => {
  const { cutId } = req.params;
  if (!UUID_PATTERN.test(cutId)) {
    return res.status(400).json({
      error: "invalid_cut_id",
      message: "O ID do corte é inválido."
    });
  }

  try {
    if (!auth.ownsResource(req.user?.id, cutId, "cut")) {
      return res.status(404).json({ error: "cut_not_found", message: "Corte não encontrado." });
    }
  } catch (error) {
    console.error("Falha ao verificar propriedade do corte:", error.message);
    return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível verificar a propriedade do corte." });
  }

  const cutPath = path.join(uploadDirectory, `${cutId}.mp4`);
  try {
    await fs.promises.access(cutPath, fs.constants.R_OK);
    return res.download(cutPath, `cortai-cut-${cutId}.mp4`);
  } catch {
    return res.status(404).json({
      error: "cut_not_found",
      message: "Corte não encontrado. Gere o corte novamente."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: "Endpoint não encontrado."
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "file_too_large",
      message: "O vídeo deve ter no máximo 100 MB."
    });
  }

  if (err.code === "UNSUPPORTED_VIDEO_FORMAT") {
    return res.status(415).json({
      error: "unsupported_video_format",
      message: "Formato não suportado. Use MP4, MOV, WebM ou MKV."
    });
  }

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: "invalid_upload",
      message: "Não foi possível receber o arquivo enviado."
    });
  }

  console.error("Erro inesperado na API:", err.message);
  return res.status(500).json({
    error: "internal_server_error",
    message: "Ocorreu um erro interno."
  });
});

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Cort-AI backend ouvindo na porta ${port}`);
  });
}

module.exports = { app, isCutDurationValid, parseIntegerSetting };
