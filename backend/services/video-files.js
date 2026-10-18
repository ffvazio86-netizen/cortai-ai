const fs = require("node:fs/promises");
const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function findUploadedVideo(directory, videoId) {
  if (typeof videoId !== "string" || !UUID_PATTERN.test(videoId)) return null;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const entry = entries.find((item) => {
    if (!item.isFile()) return false;
    const extension = path.extname(item.name).toLowerCase();
    return VIDEO_EXTENSIONS.has(extension) &&
      path.basename(item.name, extension).toLowerCase() === videoId.toLowerCase();
  });
  return entry ? path.join(directory, entry.name) : null;
}

module.exports = { findUploadedVideo, UUID_PATTERN };
