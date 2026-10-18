const express = require("express");
const { getFfmpegInfo } = require("./services/ffmpeg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", async (_req, res) => {
  const ffmpeg = await getFfmpegInfo();
  res.status(200).json({
    status: ffmpeg.available ? "ok" : "degraded",
    service: "cortai-ai-backend",
    timestamp: new Date().toISOString(),
    ffmpeg
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: "Endpoint não encontrado."
  });
});

app.use((err, _req, res, _next) => {
  console.error("Erro inesperado na API:", err.message);
  res.status(500).json({
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
