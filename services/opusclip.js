const API_BASE = "https://api.opus.pro/api";

function getConfig() {
  const apiKey = process.env.OPUSCLIP_API_KEY;
  const orgId = process.env.OPUSCLIP_ORG_ID;
  if (!apiKey) {
    const error = new Error("OpusClip API is not configured on the server.");
    error.code = "OPUSCLIP_NOT_CONFIGURED";
    throw error;
  }
  return { apiKey, orgId };
}

async function request(url, options = {}) {
  const { apiKey } = getConfig();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30_000)
  });

  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 500) }; }

  if (!response.ok) {
    const error = new Error(`OpusClip API returned HTTP ${response.status}.`);
    error.status = response.status;
    error.upstream = body;
    throw error;
  }
  return body;
}

async function createProject(videoUrl) {
  const body = await request(`${API_BASE}/clip-projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoUrl,
      curationPref: {
        model: "ClipBasic",
        clipDurations: [[60, 300]],
        skipCurate: false,
        genre: "Auto",
        enableAutoHook: false
      },
      renderPref: {
        layoutAspectRatio: "portrait",
        enableCaption: false
      }
    })
  });

  const data = body.data || body;
  const projectId = data.projectId || data.id || data.clipProjectId;
  if (!projectId) {
    const error = new Error("OpusClip did not return a project ID.");
    error.code = "OPUSCLIP_BAD_RESPONSE";
    throw error;
  }
  return { projectId: String(projectId), status: data.status || "processing" };
}

async function getProjectClips(projectId) {
  const { orgId } = getConfig();
  const url = new URL(`${API_BASE}/exportable-clips`);
  url.searchParams.set("q", "findByProjectId");
  url.searchParams.set("projectId", projectId);

  const { apiKey } = getConfig();
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (orgId) headers["x-opus-org-id"] = orgId;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  const raw = await response.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`OpusClip API returned HTTP ${response.status}.`);
    error.status = response.status;
    error.upstream = body;
    throw error;
  }
  return body.data || body;
}

module.exports = { createProject, getProjectClips };
