const test = require("node:test");
const assert = require("node:assert/strict");
const { isSupportedSource } = require("../server");

test("accepts YouTube links", () => {
  assert.equal(isSupportedSource("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(isSupportedSource("https://youtu.be/abc"), true);
});

test("accepts Twitch links", () => {
  assert.equal(isSupportedSource("https://www.twitch.tv/channel"), true);
  assert.equal(isSupportedSource("https://clips.twitch.tv/example"), true);
});

test("rejects unsupported and malformed links", () => {
  assert.equal(isSupportedSource("https://example.com/video"), false);
  assert.equal(isSupportedSource("not a url"), false);
  assert.equal(isSupportedSource("javascript:alert(1)"), false);
});
