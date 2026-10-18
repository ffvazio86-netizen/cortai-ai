const fs = require("node:fs/promises");
const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

async function cleanupExpiredFiles(directory, maxAgeMs, now = Date.now()) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    try {
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs >= maxAgeMs) {
        await fs.unlink(filePath);
        removed += 1;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return removed;
}

async function getStorageUsage(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    try {
      totalBytes += (await fs.stat(path.join(directory, entry.name))).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return totalBytes;
}

module.exports = { cleanupExpiredFiles, getStorageUsage };
