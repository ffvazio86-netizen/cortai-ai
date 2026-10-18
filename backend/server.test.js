const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
process.env.AUTH_REQUIRED = "0";
const { app, isCutDurationValid, parseIntegerSetting } = require("./server");
const uploadDirectory = path.resolve(
  process.env.CORTAI_STORAGE_DIR || path.join(os.tmpdir(), "cortai-ai-uploads")
);


test("generated cut duration must match the requested duration within tolerance", () => {
  assert.equal(isCutDurationValid(10, 10), true);
  assert.equal(isCutDurationValid(9.8, 10), true);
  assert.equal(isCutDurationValid(10.2, 10), true);
  assert.equal(isCutDurationValid(9.7, 10), false);
  assert.equal(isCutDurationValid(10.3, 10), false);
  assert.equal(isCutDurationValid(0, 10), false);
  assert.equal(isCutDurationValid(Number.NaN, 10), false);
});

async function startServer(t) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET / serves the responsive Cort-AI frontend", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(body, /name="viewport"/);
  assert.match(body, /Cortaí AI/);
  assert.match(body, /gere um corte MP4 de até 60 segundos/i);
  assert.doesNotMatch(body, /prepare 3 cortes verticais/i);
});

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

test("POST /api/videos accepts a real video and returns its duration", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cortai-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "valid.mp4");
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=black:s=64x64:d=1",
    "-frames:v", "10", "-c:v", "mpeg4", "-y", fixturePath
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  t.after(() => fs.rm(fixtureDirectory, { recursive: true, force: true }));

  const baseUrl = await startServer(t);
  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(fixturePath)], { type: "video/mp4" }), "valid.mp4");

  const response = await fetch(`${baseUrl}/api/videos`, { method: "POST", body: form });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.video.originalName, "valid.mp4");
  assert.equal(body.video.mimeType, "video/mp4");
  assert.ok(body.video.durationSeconds > 0);

  await fs.unlink(path.join(uploadDirectory, `${body.video.id}.mp4`));
});

test("POST /api/videos rejects a fake video file", async (t) => {
  const baseUrl = await startServer(t);
  const form = new FormData();
  form.append("video", new Blob(["test video content"], { type: "video/mp4" }), "teste.mp4");

  const response = await fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    body: form
  });
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.error, "invalid_video");
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


test("POST /api/videos/:videoId/cuts generates a real downloadable MP4 cut", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cortai-cut-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "source.mp4");
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=black:s=64x64:d=2",
    "-frames:v", "20", "-c:v", "mpeg4", "-y", fixturePath
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  t.after(() => fs.rm(fixtureDirectory, { recursive: true, force: true }));

  const baseUrl = await startServer(t);
  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(fixturePath)], { type: "video/mp4" }), "source.mp4");
  const uploadResponse = await fetch(`${baseUrl}/api/videos`, { method: "POST", body: form });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);

  const cutResponse = await fetch(`${baseUrl}/api/videos/${uploaded.video.id}/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startSeconds: 0, durationSeconds: 0.5 })
  });
  const cutBody = await cutResponse.json();
  assert.equal(cutResponse.status, 201);
  assert.equal(cutBody.cut.videoId, uploaded.video.id);
  assert.equal(cutBody.cut.format, "mp4");
  assert.ok(cutBody.cut.durationSeconds > 0);

  const downloadResponse = await fetch(`${baseUrl}${cutBody.cut.downloadUrl}`);
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-type"), /video\/mp4/);
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  assert.ok(downloaded.length > 100);
  const outputPath = path.join(uploadDirectory, `${cutBody.cut.id}.mp4`);
  await fs.unlink(outputPath);
  await fs.unlink(path.join(uploadDirectory, `${uploaded.video.id}.mp4`));
});

test("POST /api/videos/:videoId/cuts refuses to exceed the storage quota", async (t) => {
  const maxStorageMb = parseIntegerSetting(process.env.CORTAI_MAX_STORAGE_MB, 500, 100, 102400, "CORTAI_MAX_STORAGE_MB");
  const quotaFillPath = path.join(uploadDirectory, "cortai-quota-test.mp4");
  const handle = await fs.open(quotaFillPath, "w");
  try {
    // Sparse file: exercises quota accounting without allocating equivalent disk space.
    await handle.truncate((maxStorageMb - 50) * 1024 * 1024);
  } finally {
    await handle.close();
  }
  t.after(() => fs.rm(quotaFillPath, { force: true }));

  const baseUrl = await startServer(t);
  const response = await fetch(
    `${baseUrl}/api/videos/123e4567-e89b-42d3-a456-426614174000/cuts`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startSeconds: 0, durationSeconds: 1 })
    }
  );
  const body = await response.json();

  assert.equal(response.status, 507);
  assert.equal(body.error, "storage_limit_reached");
});

test("POST /api/videos/:videoId/cuts rejects invalid parameters", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/videos/123e4567-e89b-42d3-a456-426614174000/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startSeconds: -1, durationSeconds: 90 })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "invalid_cut_parameters");
});

test("GET /api/cuts/:cutId/download rejects malformed IDs", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/cuts/../../package.json/download`);
  assert.ok([400, 404].includes(response.status));
});
