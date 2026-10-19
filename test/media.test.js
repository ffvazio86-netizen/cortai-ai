const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseSegments } = require("../media/ffmpeg");

test("plans three clips within the requested duration", () => {
  const clips = chooseSegments(1200, 3, 180);
  assert.equal(clips.length, 3);
  for (const clip of clips) {
    assert.ok(clip.start >= 0);
    assert.equal(clip.duration, 180);
    assert.ok(clip.start + clip.duration <= 1200);
  }
});

test("rejects sources shorter than one minute", () => {
  assert.throws(() => chooseSegments(45, 1, 60), /at least 60 seconds/);
});

test("rejects durations outside 1–5 minutes", () => {
  assert.throws(() => chooseSegments(900, 1, 30), /between 60 and 300/);
  assert.throws(() => chooseSegments(900, 1, 301), /between 60 and 300/);
});

test("limits the MVP to three clips", () => {
  assert.throws(() => chooseSegments(900, 4, 60), /one to three clips/);
});
