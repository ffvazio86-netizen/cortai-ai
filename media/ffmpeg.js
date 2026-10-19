const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");

const execFileAsync = promisify(execFile);

async function run(binary, args) {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: 30 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = error.stderr || error.message || "Unknown FFmpeg error";
    throw new Error(`${binary} failed: ${String(detail).slice(-2000)}`);
  }
}

async function probeDuration(inputPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputPath
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine source video duration.");
  }
  return duration;
}

function chooseSegments(duration, count = 3, clipSeconds = 60) {
  if (!Number.isFinite(duration) || duration < 1) {
    throw new Error("Video duration must be at least one second.");
  }
  if (!Number.isInteger(count) || count < 1 || count > 3) {
    throw new Error("This MVP supports one to three clips.");
  }
  if (!Number.isFinite(clipSeconds) || clipSeconds < 60 || clipSeconds > 300) {
    throw new Error("Clip duration must be between 60 and 300 seconds.");
  }
  const actualLength = Math.min(clipSeconds, duration);
  const maxStart = Math.max(0, duration - actualLength);
  if (count === 1 || maxStart === 0) {
    return [{ start: 0, duration: actualLength }];
  }
  return Array.from({ length: count }, (_, index) => ({
    start: maxStart * (index / (count - 1)),
    duration: actualLength
  }));
}

async function createVerticalClips({ inputPath, outputDir, count = 3, clipSeconds = 60 }) {
  const source = path.resolve(inputPath);
  const targetDir = path.resolve(outputDir);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("Authorized source video file was not found.");

  await fs.mkdir(targetDir, { recursive: true });
  const duration = await probeDuration(source);
  const segments = chooseSegments(duration, count, clipSeconds);
  const outputs = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const outputPath = path.join(targetDir, `cortai-cut-${i + 1}.mp4`);
    await run("ffmpeg", [
      "-hide_banner", "-y",
      "-ss", String(segment.start),
      "-i", source,
      "-t", String(segment.duration),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-map", "0:v:0", "-map", "0:a?",
      outputPath
    ]);
    const outStat = await fs.stat(outputPath).catch(() => null);
    if (!outStat || outStat.size === 0) {
      throw new Error(`FFmpeg did not create clip ${i + 1}.`);
    }
    outputs.push({ path: outputPath, start: segment.start, duration: segment.duration, bytes: outStat.size });
  }
  return outputs;
}

module.exports = { chooseSegments, probeDuration, createVerticalClips };
