const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("./server");

test("GET /api/health returns backend and FFmpeg status", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.service, "cortai-ai-backend");
  assert.ok(["ok", "degraded"].includes(body.status));
  assert.equal(typeof body.timestamp, "string");
  assert.equal(typeof body.ffmpeg.available, "boolean");
  assert.ok("version" in body.ffmpeg);
});

test("unknown routes return JSON 404", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/not-a-route`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "not_found");
});
