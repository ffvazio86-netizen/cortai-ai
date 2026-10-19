import test from "node:test";
import assert from "node:assert/strict";

function validVideoUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return (url.protocol === "https:" || url.protocol === "http:") &&
      ["youtube.com", "youtu.be", "m.youtube.com", "youtube-nocookie.com", "twitch.tv", "m.twitch.tv", "clips.twitch.tv"].includes(host);
  } catch { return false; }
}

test("accepts YouTube and Twitch links", () => {
  assert.equal(validVideoUrl("https://youtu.be/abc123"), true);
  assert.equal(validVideoUrl("https://www.youtube.com/watch?v=abc123"), true);
  assert.equal(validVideoUrl("https://www.twitch.tv/videos/123456"), true);
  assert.equal(validVideoUrl("https://clips.twitch.tv/SomeClip"), true);
});

test("rejects other hosts and malformed URLs", () => {
  assert.equal(validVideoUrl("https://example.com/video"), false);
  assert.equal(validVideoUrl("not a url"), false);
  assert.equal(validVideoUrl("javascript:alert(1)"), false);
  assert.equal(validVideoUrl("https://youtube.com.example.org/watch?v=x"), false);
});
