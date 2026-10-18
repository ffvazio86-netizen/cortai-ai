const express = require("express");
const multer = require("multer");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { getFfmpegInfo } = require("./services/ffmpeg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const uploadDirectory = path.join(os.tmpdir(), "cortai-ai-uploads");
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
  videoUpload.single("video")(req, res, (error) => {
    if (error) return next(error);
    if (!req.file) {
      return res.status(400).json({
        error: "video_required",
        message: "Envie um arquivo no campo 'video'."
      });
    }

    return res.status(201).json({
      message: "Vídeo recebido para a próxima etapa de processamento.",
      video: {
        id: path.basename(req.file.filename, path.extname(req.file.filename)),
        originalName: path.basename(req.file.originalname),
        size: req.file.size,
        mimeType: req.file.mimetype
      }
    });
  });
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
