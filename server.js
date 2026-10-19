const express = require("express");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const { createProject, getProjectClips } = require("./services/opusclip");

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
  res.json({
    ok: true,
    app: "Cort-AI",
    stage: process.env.OPUSCLIP_API_KEY ? "opusclip-configured" : "awaiting-opusclip-credentials"
  });
});

app.post("/api/validate-link", async (req, res) => {
  const link = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!link || !isSupportedSource(link)) {
    return res.status(400).json({
      ok: false,
      message: "Cole um link válido do YouTube ou da Twitch."
    });
  }

  try {
    const project = await createProject(link);
    return res.status(202).json({
      ok: true,
      projectId: project.projectId,
      status: project.status,
      message: "O projeto foi enviado ao OpusClip. O processamento pode levar alguns minutos."
    });
  } catch (error) {
    if (error.code === "OPUSCLIP_NOT_CONFIGURED") {
      return res.status(503).json({
        ok: false,
        message: "A integração ainda não está configurada no servidor. A chave da API deve ser adicionada como variável secreta; não a envie no chat."
      });
    }
    if (error.code === "OPUSCLIP_ORG_NOT_CONFIGURED") {
      return res.status(503).json({
        ok: false,
        message: "Falta configurar o identificador da organização OpusClip no servidor."
      });
    }
    const upstreamStatus = error.status || 502;
    console.error("OpusClip project creation failed:", upstreamStatus, error.code || "API_ERROR");
    return res.status(502).json({
      ok: false,
      message: upstreamStatus === 401 || upstreamStatus === 403
        ? "O OpusClip recusou a solicitação. Confira se sua conta tem acesso à API e se as credenciais do servidor estão corretas."
        : upstreamStatus === 402
          ? "A conta OpusClip não tem créditos suficientes ou o plano não permite esse uso da API."
          : "Não foi possível iniciar o projeto no OpusClip. Tente novamente mais tarde."
    });
  }
});

app.get("/api/projects/:projectId/clips", async (req, res) => {
  const projectId = String(req.params.projectId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
    return res.status(400).json({ ok: false, message: "ID de projeto inválido." });
  }
  try {
    const clips = await getProjectClips(projectId);
    return res.json({ ok: true, clips });
  } catch (error) {
    if (error.code === "OPUSCLIP_NOT_CONFIGURED" || error.code === "OPUSCLIP_ORG_NOT_CONFIGURED") {
      return res.status(503).json({ ok: false, message: "A integração OpusClip ainda não está totalmente configurada no servidor." });
    }
    console.error("OpusClip clips lookup failed:", error.status || 502);
    return res.status(502).json({ ok: false, message: "Não foi possível consultar os cortes agora." });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Cort-AI listening on port ${PORT}`);
  });
}

module.exports = { app, isSupportedSource };
