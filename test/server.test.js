import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, validVideoUrl } from "../server.js";

let server;
let baseUrl;

before(async () => {
  process.env.SESSION_SECRET ||= "cortai-test-session-secret-with-more-than-32-bytes";
  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function sessionCookie(sub = "test-user") {
  const payload = Buffer.from(JSON.stringify({
    sub,
    email: "test@example.com",
    name: "Cort-AI test",
    exp: Date.now() + 60_000
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
  return `cortai_session=${encodeURIComponent(payload + "." + signature)}`;
}

test("aceita links do YouTube e da Twitch", () => {
  assert.equal(validVideoUrl("https://youtu.be/abc123"), true);
  assert.equal(validVideoUrl("https://www.youtube.com/watch?v=abc123"), true);
  assert.equal(validVideoUrl("https://www.twitch.tv/videos/123456"), true);
  assert.equal(validVideoUrl("https://clips.twitch.tv/SomeClip"), true);
});

test("rejeita hosts externos e URLs malformadas", () => {
  assert.equal(validVideoUrl("https://example.com/video"), false);
  assert.equal(validVideoUrl("not a url"), false);
  assert.equal(validVideoUrl("javascript:alert(1)"), false);
  assert.equal(validVideoUrl("https://youtube.com.example.org/watch?v=x"), false);
});

test("endpoint de sessão informa quando não há login", async () => {
  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { authenticated: false });
});

test("endpoint de saúde responde com o serviço Cort-AI", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "Cort-AI", version: "1.0.0" });
});

test("API de cortes exige login antes de validar o link", async () => {
  const response = await fetch(`${baseUrl}/api/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/video", authorized: true })
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("API de cortes exige login antes de processar", async () => {
  const response = await fetch(`${baseUrl}/api/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/abc123", authorized: false })
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("consulta de tarefas exige login", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/id-qualquer`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("arquivos de cortes exigem login", async () => {
  const response = await fetch(`${baseUrl}/cuts/id-qualquer/corte-1.mp4`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("upload exige login antes de aceitar dados", async () => {
  const response = await fetch(`${baseUrl}/api/upload?authorized=true&filename=video.mp4`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from("video")
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("gera três arquivos MP4 reais a partir de um vídeo enviado", { timeout: 240_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortai-e2e-"));
  try {
    const input = path.join(temp, "sample.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "181", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input
    ], { stdio: "ignore" });
    const bytes = await readFile(input);
    const cookie = sessionCookie();

    const upload = await fetch(`${baseUrl}/api/upload?authorized=true&filename=sample.mp4`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", cookie },
      body: bytes
    });
    assert.equal(upload.status, 202, await upload.text());
    const { jobId } = await upload.json();
    assert.ok(jobId);

    let status;
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      status = await response.json();
      if (status.status === "done" || status.status === "error") break;
    }
    assert.equal(status?.status, "done", status?.message || "O processamento não terminou no prazo.");
    assert.equal(status.cuts.length, 3);

    for (const cut of status.cuts) {
      const response = await fetch(new URL(cut.url, baseUrl), { headers: { cookie } });
      assert.equal(response.status, 200, `Falha ao baixar ${cut.name}`);
      assert.match(response.headers.get("content-type") || "", /video\/mp4/);
      const output = Buffer.from(await response.arrayBuffer());
      assert.ok(output.length > 10_000, `${cut.name} parece vazio`);
      const outputPath = path.join(temp, cut.name);
      await import("node:fs/promises").then(fs => fs.writeFile(outputPath, output));
      const duration = Number(execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", outputPath
      ], { encoding: "utf8" }).trim());
      assert.ok(duration >= 59 && duration <= 61, `${cut.name} tem duração inesperada: ${duration}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
