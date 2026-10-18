const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtemp(path.join(os.tmpdir(), "cortai-auth-test-"));
const sessionSecret = "test-only-session-secret-that-is-at-least-32-bytes";
process.env.AUTH_REQUIRED = "1";
process.env.CORTAI_SESSION_SECRET = sessionSecret;
process.env.CORTAI_DATABASE_PATH = path.join(os.tmpdir(), `cortai-auth-test-${process.pid}.sqlite`);
process.env.GOOGLE_CLIENT_ID = "";
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

async function request(baseUrl, endpoint, payload, cookie) {
  const response = await fetch(baseUrl + endpoint, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { response, body: await response.json() };
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected a session cookie");
  return value.split(";")[0];
}

test("email registration, login, session lookup and logout", async (t) => {
  const baseUrl = await startServer(t);
  const email = `auth-${process.pid}@example.com`;
  const password = "this-is-a-long-test-password";

  const registered = await request(baseUrl, "/api/auth/register", { email, password });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.email, email);
  assert.equal("password_hash" in registered.body.user, false);
  const cookie = sessionCookie(registered.response);

  const me = await request(baseUrl, "/api/auth/me", undefined, cookie);
  assert.equal(me.response.status, 200);
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.email, email);

  const logout = await request(baseUrl, "/api/auth/logout", {}, cookie);
  assert.equal(logout.response.status, 200);

  const afterLogout = await request(baseUrl, "/api/auth/me", undefined, cookie);
  assert.equal(afterLogout.response.status, 401);
});

test("email login rejects incorrect passwords and accepts correct passwords", async (t) => {
  const baseUrl = await startServer(t);
  const email = `login-${process.pid}@example.com`;
  const password = "another-long-test-password";
  const registered = await request(baseUrl, "/api/auth/register", { email, password });
  assert.equal(registered.response.status, 201);

  const wrong = await request(baseUrl, "/api/auth/login", { email, password: "incorrect-password" });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.body.error, "invalid_credentials");

  const login = await request(baseUrl, "/api/auth/login", { email: email.toUpperCase(), password });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.email, email);
  assert.ok(sessionCookie(login.response));
});

test("registration validates email and password and prevents duplicate accounts", async (t) => {
  const baseUrl = await startServer(t);
  const invalidEmail = await request(baseUrl, "/api/auth/register", {
    email: "not-an-email", password: "this-is-a-long-password"
  });
  assert.equal(invalidEmail.response.status, 400);

  const weakPassword = await request(baseUrl, "/api/auth/register", {
    email: `weak-${process.pid}@example.com`, password: "short"
  });
  assert.equal(weakPassword.response.status, 400);

  const payload = { email: `duplicate-${process.pid}@example.com`, password: "this-is-a-long-password" };
  assert.equal((await request(baseUrl, "/api/auth/register", payload)).response.status, 201);
  const duplicate = await request(baseUrl, "/api/auth/register", { ...payload, email: payload.email.toUpperCase() });
  assert.equal(duplicate.response.status, 409);
});

test("protected video endpoints reject requests without a session", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(baseUrl + "/api/videos", { method: "POST" });
  assert.equal(response.status, 401);
  const download = await fetch(baseUrl + "/api/cuts/00000000-0000-4000-8000-000000000000/download");
  assert.equal(download.status, 401);
});

test("Google sign-in reports missing configuration without creating a session", async (t) => {
  const baseUrl = await startServer(t);
  const result = await request(baseUrl, "/api/auth/google", { credential: "not-a-token" });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, "google_not_configured");
});
