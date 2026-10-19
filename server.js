const express = require("express");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function isSupportedSource(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be" ||
    host === "twitch.tv" ||
    host === "m.twitch.tv" ||
    host === "clips.twitch.tv";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "Cort-AI", stage: "scaffold" });
});

app.post("/api/validate-link", (req, res) => {
  const link = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!link || !isSupportedSource(link)) {
    return res.status(400).json({
      ok: false,
      message: "Cole um link válido do YouTube ou da Twitch."
    });
  }

  return res.status(501).json({
    ok: false,
    stage: "link-validation",
    message: "O link foi reconhecido, mas a geração dos cortes ainda não está conectada. Não vamos mostrar cortes falsos: o próximo passo é integrar uma fonte de vídeo autorizada e testar o FFmpeg."
  });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Cort-AI listening on port ${PORT}`);
  });
}

module.exports = { app, isSupportedSource };
