const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app } = require("./server");

async function startServer(t) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /api/health returns backend and FFmpeg status", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.service, "cortai-ai-backend");
  assert.ok(["ok", "degraded"].includes(body.status));
  assert.equal(typeof body.timestamp, "string");
  assert.equal(typeof body.ffmpeg.available, "boolean");
  assert.ok("version" in body.ffmpeg);
});

test("unknown routes return JSON 404", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/not-a-route`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "not_found");
});

test("POST /api/videos receives a supported video", async (t) => {
  const baseUrl = await startServer(t);
  const form = new FormData();
  form.append("video", new Blob(["test video content"], { type: "video/mp4" }), "teste.mp4");

  const response = await fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    body: form
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.video.originalName, "teste.mp4");
  assert.equal(body.video.mimeType, "video/mp4");
  assert.equal(body.video.size, 17);

  const storedPath = path.join(os.tmpdir(), "cortai-ai-uploads", `${body.video.id}.mp4`);
  await fs.unlink(storedPath);
});

test("POST /api/videos rejects unsupported file formats", async (t) => {
  const baseUrl = await startServer(t);
  const form = new FormData();
  form.append("video", new Blob(["not a video"], { type: "text/plain" }), "arquivo.txt");

  const response = await fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    body: form
  });
  const body = await response.json();

  assert.equal(response.status, 415);
  assert.equal(body.error, "unsupported_video_format");
});

test("POST /api/videos requires a file", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    body: new FormData()
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "video_required");
});
