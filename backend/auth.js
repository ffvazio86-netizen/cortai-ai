const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const COOKIE = "cortai_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== "0";
let db;

if (process.env.NODE_ENV === "production" && !process.env.CORTAI_STORAGE_DIR) {
  console.warn("Cort-AI: CORTAI_STORAGE_DIR não está definido em produção; vídeos e o banco de autenticação podem ser perdidos ao reiniciar.");
}
if (process.env.NODE_ENV === "production" && !process.env.CORTAI_DATABASE_PATH) {
  console.warn("Cort-AI: defina CORTAI_DATABASE_PATH explicitamente em um disco persistente em produção.");
}
if (process.env.NODE_ENV === "production" && !process.env.CORTAI_PUBLIC_ORIGIN) {
  console.warn("Cort-AI: defina CORTAI_PUBLIC_ORIGIN com a origem HTTPS pública para validar origens de autenticação.");
}

function configured() {
  return typeof process.env.CORTAI_SESSION_SECRET === "string" &&
    Buffer.byteLength(process.env.CORTAI_SESSION_SECRET) >= 32;
}

function database() {
  if (!configured()) {
    const error = new Error("CORTAI_SESSION_SECRET must contain at least 32 bytes.");
    error.code = "AUTH_NOT_CONFIGURED";
    throw error;
  }
  if (db) return db;
  const dataDir = process.env.CORTAI_STORAGE_DIR || path.join(os.tmpdir(), "cortai-ai-uploads");
  const filename = path.resolve(process.env.CORTAI_DATABASE_PATH || path.join(dataDir, "cortai-auth.sqlite"));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS owned_resources (
      resource_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('video', 'cut')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resources_user_idx ON owned_resources(user_id, kind);
  `);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return db;
}

function hashToken(token) {
  return crypto.createHmac("sha256", process.env.CORTAI_SESSION_SECRET).update(token).digest("hex");
}

function parseCookies(header = "") {
  const result = Object.create(null);
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function setCookie(res, token, maxAge = SESSION_SECONDS) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = process.env.NODE_ENV === "production" && process.env.CORTAI_ALLOWED_ORIGIN ? "None" : "Lax";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`);
}

function clearCookie(res) {
  setCookie(res, "", 0);
}

function checkOrigin(req, res) {
  const origin = req.get("origin");
  if (!origin) return true;
  let expected;
  try {
    // Render terminates HTTPS at its proxy, so Express may see HTTP internally.
    // Prefer explicit origins; otherwise honor Render's forwarded HTTPS protocol
    // when deriving the same-origin fallback.
    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0].trim();
    const requestProtocol = process.env.TRUST_PROXY === "1"
      ? req.protocol
      : (forwardedProto === "https" ? "https" : req.protocol);
    expected = new URL(process.env.CORTAI_ALLOWED_ORIGIN || process.env.CORTAI_PUBLIC_ORIGIN || `${requestProtocol}://${req.get("host")}`).origin;
  } catch {
    res.status(403).json({ error: "invalid_origin", message: "Origem inválida." });
    return false;
  }
  if (origin !== expected) {
    res.status(403).json({ error: "invalid_origin", message: "Origem não permitida." });
    return false;
  }
  return true;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" ||
      !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false;
  const key = Buffer.from(await scrypt(password, Buffer.from(parts[1], "hex"), 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(parts[2], "hex");
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: new Date(row.created_at).toISOString() };
}

function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  database().prepare("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, Date.now() + SESSION_SECONDS * 1000);
  setCookie(res, token);
}

function authConfigError(res) {
  if (configured()) return false;
  res.status(503).json({
    error: "auth_not_configured",
    message: "Autenticação indisponível. Configure CORTAI_SESSION_SECRET com pelo menos 32 bytes."
  });
  return true;
}

function authenticate(req, res, next) {
  if (!AUTH_REQUIRED) { req.user = null; return next(); }
  if (authConfigError(res)) return;
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      return res.status(401).json({ error: "authentication_required", message: "Entre na sua conta para continuar." });
    }
    const row = database().prepare(`
      SELECT u.id, u.email, u.created_at FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), Date.now());
    if (!row) {
      clearCookie(res);
      return res.status(401).json({ error: "authentication_required", message: "Sua sessão expirou. Entre novamente." });
    }
    req.user = publicUser(row);
    return next();
  } catch (error) {
    console.error("Falha ao validar sessão:", error.message);
    return res.status(503).json({ error: "auth_storage_unavailable", message: "Autenticação temporariamente indisponível." });
  }
}

function recordResource(userId, resourceId, kind) {
  if (!AUTH_REQUIRED) return;
  if (!userId) throw new Error("Authenticated user missing while recording resource.");
  database().prepare("INSERT INTO owned_resources(resource_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)")
    .run(resourceId, userId, kind, Date.now());
}

function ownsResource(userId, resourceId, kind) {
  if (!AUTH_REQUIRED) return true;
  return Boolean(userId && database().prepare(
    "SELECT 1 FROM owned_resources WHERE user_id = ? AND resource_id = ? AND kind = ?"
  ).get(userId, resourceId, kind));
}

let googleKeys = null;
let googleKeysExpiresAt = 0;

async function verifyGoogleCredential(credential) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    const error = new Error("GOOGLE_CLIENT_ID is not configured.");
    error.code = "GOOGLE_NOT_CONFIGURED";
    throw error;
  }
  if (typeof credential !== "string" || credential.length > 10000) {
    const error = new Error("Invalid Google credential.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  const parts = credential.split(".");
  if (parts.length !== 3) {
    const error = new Error("Invalid Google credential.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    const error = new Error("Invalid Google credential.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    const error = new Error("Unsupported Google credential.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  if (!googleKeys || Date.now() >= googleKeysExpiresAt) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Could not retrieve Google signing keys.");
    googleKeys = await response.json();
    const cache = response.headers.get("cache-control") || "";
    const seconds = Number(cache.match(/max-age=(\d+)/)?.[1] || 300);
    googleKeysExpiresAt = Date.now() + Math.min(Math.max(seconds, 60), 3600) * 1000;
  }
  const jwk = googleKeys.keys?.find((key) => key.kid === header.kid && key.alg === "RS256");
  if (!jwk) {
    googleKeys = null;
    const error = new Error("Unknown Google signing key.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const validSignature = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`),
    key, Buffer.from(parts[2], "base64url"));
  const now = Math.floor(Date.now() / 1000);
  const issuerOk = claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com";
  const audienceOk = claims.aud === process.env.GOOGLE_CLIENT_ID ||
    (Array.isArray(claims.aud) && claims.aud.includes(process.env.GOOGLE_CLIENT_ID));
  if (!validSignature || !issuerOk || !audienceOk || !claims.sub ||
      !claims.email || claims.email_verified !== true ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.iat && claims.iat > now + 60)) {
    const error = new Error("Google credential validation failed.");
    error.code = "INVALID_GOOGLE_CREDENTIAL";
    throw error;
  }
  return { sub: String(claims.sub), email: String(claims.email).trim().toLowerCase() };
}

function registerRoutes(app, rateLimit) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10,
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "auth_rate_limit", message: "Muitas tentativas. Aguarde 15 minutos." }
  });

  app.get("/api/auth/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "" });
  });

  app.get("/api/auth/me", authenticate, (req, res) => {
    res.json({ authenticated: Boolean(req.user), user: req.user || null });
  });

  app.post("/api/auth/register", limiter, (req, res) => {
    if (!checkOrigin(req, res)) return;
    return res.status(410).json({
      error: "registration_disabled",
      message: "O cadastro foi desativado. Entre com o usuário e a senha fornecidos."
    });
  });

  app.post("/api/auth/login", limiter, async (req, res) => {
    if (!checkOrigin(req, res) || authConfigError(res)) return;
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (username !== "grego" || password !== "grego") {
      return res.status(401).json({
        error: "invalid_credentials",
        message: "Usuário ou senha incorretos."
      });
    }
    try {
      const store = database();
      const email = "grego@cortai.local";
      let row = store.prepare("SELECT id, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE").get(email);
      if (!row) {
        const id = crypto.randomUUID();
        const passwordHash = await hashPassword(password);
        store.prepare("INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .run(id, email, passwordHash, Date.now());
        row = store.prepare("SELECT id, email, password_hash, created_at FROM users WHERE id = ?").get(id);
      }
      const existing = parseCookies(req.headers.cookie)[COOKIE];
      if (existing) store.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(existing));
      createSession(row.id, res);
      return res.json({
        message: "Login realizado com sucesso.",
        user: { id: row.id, username: "grego", email: "grego" }
      });
    } catch (error) {
      console.error("Falha no login:", error.message);
      return res.status(503).json({
        error: "auth_storage_unavailable",
        message: "Não foi possível entrar agora. Verifique a configuração de autenticação do servidor."
      });
    }
  });

  app.post("/api/auth/google", limiter, (req, res) => {
    if (!checkOrigin(req, res)) return;
    return res.status(410).json({
      error: "google_login_disabled",
      message: "O login com Google foi desativado."
    });
  });

  app.get("/api/auth/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ googleClientId: "" });
  });

  app.get("/api/auth/me", authenticate, (req, res) => {
    res.json({
      authenticated: Boolean(req.user),
      user: req.user ? { id: req.user.id, username: "grego", email: "grego" } : null
    });
  });

  app.post("/api/auth/logout", authenticate, (req, res) => {
    if (!checkOrigin(req, res) || authConfigError(res)) return;
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) database().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
      clearCookie(res);
      return res.json({ message: "Você saiu da sua conta." });
    } catch (error) {
      console.error("Falha ao sair:", error.message);
      return res.status(503).json({ error: "auth_storage_unavailable", message: "Não foi possível encerrar a sessão." });
    }
  });
}

module.exports = { AUTH_REQUIRED, authenticate, registerRoutes, recordResource, ownsResource, configured };
