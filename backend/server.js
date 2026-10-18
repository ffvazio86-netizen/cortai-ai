const express = require("express");
const multer = require("multer");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { getFfmpegInfo } = require("./services/ffmpeg");
const { probeVideo } = require("./services/video-validation");
const { generateVideoCut } = require("./services/video-cut");
const { findUploadedVideo, UUID_PATTERN } = require("./services/video-files");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const uploadDirectory = path.resolve(
  process.env.CORTAI_STORAGE_DIR || path.join(os.tmpdir(), "cortai-ai-uploads")
);
fs.mkdirSync(uploadDirectory, { recursive: true });

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
    fileSize: 100 * 1024 * 1024,
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

app.post("/api/videos", (req, res, next) => {
  videoUpload.single("video")(req, res, async (error) => {
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

      return res.status(201).json({
        message: "Vídeo válido recebido para a próxima etapa de processamento.",
        video: {
          id: path.basename(req.file.filename, path.extname(req.file.filename)),
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

app.post("/api/videos/:videoId/cuts", async (req, res) => {
  const { videoId } = req.params;
  if (!UUID_PATTERN.test(videoId)) {
    return res.status(400).json({
      error: "invalid_video_id",
      message: "O ID do vídeo é inválido."
    });
  }

  const { startSeconds, durationSeconds } = req.body || {};
  if (
    typeof startSeconds !== "number" ||
    !Number.isFinite(startSeconds) ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    startSeconds < 0 ||
    durationSeconds <= 0 ||
    durationSeconds > 60
  ) {
    return res.status(400).json({
      error: "invalid_cut_parameters",
      message: "Informe startSeconds >= 0 e durationSeconds entre 0 e 60 segundos."
    });
  }

  let inputPath;
  try {
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
      await generateVideoCut(inputPath, outputPath, startSeconds, durationSeconds);
      const output = await probeVideo(outputPath);
      if (!output.valid) {
        throw Object.assign(new Error("Generated cut failed validation."), { code: "FFMPEG_CUT_FAILED" });
      }
      return res.status(201).json({
        message: "Corte gerado com sucesso.",
        cut: {
          id: cutId,
          videoId,
          startSeconds,
          durationSeconds: output.duration,
          format: "mp4",
          downloadUrl: `/api/cuts/${cutId}/download`
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
      if (error.code === "FFMPEG_CUT_FAILED" || error.code === "ENOENT") {
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
  }
});

app.get("/api/cuts/:cutId/download", async (req, res) => {
  const { cutId } = req.params;
  if (!UUID_PATTERN.test(cutId)) {
    return res.status(400).json({
      error: "invalid_cut_id",
      message: "O ID do corte é inválido."
    });
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

module.exports = { app };
