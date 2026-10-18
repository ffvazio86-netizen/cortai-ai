const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { cleanupExpiredFiles, getStorageUsage } = require("./video-storage");

test("cleanupExpiredFiles removes only expired video files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cortai-storage-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oldVideo = path.join(directory, "old.mp4");
  const newVideo = path.join(directory, "new.mp4");
  const oldText = path.join(directory, "old.txt");
  await Promise.all([
    fs.writeFile(oldVideo, "old"),
    fs.writeFile(newVideo, "new"),
    fs.writeFile(oldText, "keep")
  ]);
  const now = Date.now();
  await fs.utimes(oldVideo, new Date(now - 10_000), new Date(now - 10_000));
  await fs.utimes(oldText, new Date(now - 10_000), new Date(now - 10_000));

  const removed = await cleanupExpiredFiles(directory, 5_000, now);

  assert.equal(removed, 1);
  await assert.rejects(fs.access(oldVideo), { code: "ENOENT" });
  await fs.access(newVideo);
  await fs.access(oldText);
});

test("getStorageUsage counts supported video files only", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cortai-storage-size-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "one.mp4"), Buffer.alloc(7));
  await fs.writeFile(path.join(directory, "two.mkv"), Buffer.alloc(11));
  await fs.writeFile(path.join(directory, "notes.txt"), Buffer.alloc(100));

  assert.equal(await getStorageUsage(directory), 18);
});
