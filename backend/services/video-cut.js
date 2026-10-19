const { spawn } = require("node:child_process");

function generateVideoCut(inputPath, outputPath, startSeconds, durationSeconds, timeoutMs = 60000, maxOutputBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let timer;
    let child;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    try {
      child = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-ss", String(startSeconds),
        "-i", inputPath,
        "-t", String(durationSeconds),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-fs", String(maxOutputBytes),
        "-y",
        outputPath
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error("FFmpeg cut timed out.");
      error.code = "FFMPEG_TIMEOUT";
      finish(error);
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) return finish();
      const error = new Error("FFmpeg could not generate the requested cut.");
      error.code = "FFMPEG_CUT_FAILED";
      error.details = stderr;
      finish(error);
    });
  });
}

module.exports = { generateVideoCut };
