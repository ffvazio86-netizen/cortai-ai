const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeAudio, MAX_AUDIO_BYTES } = require("./audio-transcription");

test("transcription requires an API key before invoking FFmpeg", async () => {
  await assert.rejects(
    transcribeAudio({
      inputPath: "/not-used.mp4",
      audioPath: "/not-used.mp3",
      apiKey: "",
      fetchImpl: async () => { throw new Error("fetch should not be called"); }
    }),
    error => error.code === "AI_NOT_CONFIGURED"
  );
});

test("audio upload limit stays below the OpenAI transcription file limit", () => {
  assert.ok(MAX_AUDIO_BYTES > 0);
  assert.ok(MAX_AUDIO_BYTES < 25 * 1024 * 1024);
});
