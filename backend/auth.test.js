const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

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

test("shared username login, session lookup and logout", async (t) => {
  const baseUrl = await startServer(t);

  const wrong = await request(baseUrl, "/api/auth/login", { username: "grego", password: "wrong" });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.body.error, "invalid_credentials");

  const login = await request(baseUrl, "/api/auth/login", { username: "grego", password: "grego" });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.username, "grego");
  const cookie = sessionCookie(login.response);

  const me = await request(baseUrl, "/api/auth/me", undefined, cookie);
  assert.equal(me.response.status, 200);
  assert.equal(me.body.authenticated, true);

  const logout = await request(baseUrl, "/api/auth/logout", {}, cookie);
  assert.equal(logout.response.status, 200);

  const afterLogout = await request(baseUrl, "/api/auth/me", undefined, cookie);
  assert.equal(afterLogout.response.status, 401);
});

test("registration and Google login are disabled", async (t) => {
  const baseUrl = await startServer(t);

  const register = await request(baseUrl, "/api/auth/register", {
    email: "test@example.com", password: "a-long-test-password"
  });
  assert.equal(register.response.status, 410);
  assert.equal(register.body.error, "registration_disabled");

  const google = await request(baseUrl, "/api/auth/google", { credential: "not-a-token" });
  assert.equal(google.response.status, 410);
  assert.equal(google.body.error, "google_login_disabled");
});

test("protected video endpoints reject requests without a session", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(baseUrl + "/api/videos", { method: "POST" });
  assert.equal(response.status, 401);
  const download = await fetch(baseUrl + "/api/cuts/00000000-0000-4000-8000-000000000000/download");
  assert.equal(download.status, 401);
});
