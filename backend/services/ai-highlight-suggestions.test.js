const test = require("node:test");
const assert = require("node:assert/strict");
const { suggestHighlights, validateTranscript, validateSuggestions } = require("./ai-highlight-suggestions");

const segments = [
  { startSeconds: 0, endSeconds: 90, text: "A abertura do vídeo." },
  { startSeconds: 90, endSeconds: 190, text: "Uma discussão importante." },
  { startSeconds: 190, endSeconds: 300, text: "Conclusão e reação." }
];

test("transcript validation rejects invalid duration and timestamps", () => {
  assert.throws(() => validateTranscript(299, segments), { code: "INVALID_VIDEO_DURATION" });
  assert.throws(() => validateTranscript(600, [{ startSeconds: 20, endSeconds: 10, text: "inválido" }]), {
    code: "INVALID_TRANSCRIPT"
  });
  assert.equal(validateTranscript(600, segments).length, 3);
});

test("suggestions enforce a duration strictly above one minute and below five minutes", () => {
  assert.equal(validateSuggestions([{ startSeconds: 0, endSeconds: 61, title: "Válido" }], 600).length, 1);
  assert.throws(() => validateSuggestions([{ startSeconds: 0, endSeconds: 60, title: "Curto" }], 600), {
    code: "AI_INVALID_RESPONSE"
  });
  assert.throws(() => validateSuggestions([{ startSeconds: 0, endSeconds: 300, title: "Longo" }], 600), {
    code: "AI_INVALID_RESPONSE"
  });
  assert.throws(() => validateSuggestions([{ startSeconds: 590, endSeconds: 650, title: "Fora" }], 600), {
    code: "AI_INVALID_RESPONSE"
  });
});

test("AI suggestions call OpenAI with a backend-only key and return validated cuts", async () => {
  let request;
  const cuts = await suggestHighlights({
    durationSeconds: 600,
    segments,
    apiKey: "test-key-not-real",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          output: [{
            content: [{
              type: "output_text",
              text: JSON.stringify({
                cuts: [{
                  startSeconds: 90,
                  endSeconds: 210,
                  title: "Discussão principal",
                  reason: "Trecho com contexto e informação relevante"
                }]
              })
            }]
          }]
        })
      };
    }
  });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key-not-real");
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].durationSeconds, 120);
  assert.equal(cuts[0].title, "Discussão principal");
});

test("AI integration reports missing API key without making a request", async () => {
  await assert.rejects(
    suggestHighlights({ durationSeconds: 600, segments, apiKey: "" }),
    { code: "AI_NOT_CONFIGURED" }
  );
});

test("AI provider errors do not expose provider response bodies", async () => {
  await assert.rejects(
    suggestHighlights({
      durationSeconds: 600,
      segments,
      apiKey: "test-key-not-real",
      fetchImpl: async () => ({ ok: false, status: 401 })
    }),
    { code: "AI_PROVIDER_ERROR", status: 401 }
  );
});
