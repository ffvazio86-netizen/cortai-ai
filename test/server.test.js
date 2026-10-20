import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, validVideoUrl } from "../server.js";

let server;
let baseUrl;

before(async () => {
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

test("API rejeita link externo sem iniciar processamento", async () => {
  const response = await fetch(`${baseUrl}/api/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/video", authorized: true })
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /login/);
});

test("API exige confirmação de autorização", async () => {
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
