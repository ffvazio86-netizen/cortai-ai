const { spawn } = require("node:child_process");

function getFfmpegInfo(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;

    try {
      child = spawn("ffmpeg", ["-version"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      finish({
        available: false,
        version: null,
        error: "FFmpeg could not be started."
      });
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        available: false,
        version: null,
        error: "FFmpeg check timed out."
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", () => {
      finish({
        available: false,
        version: null,
        error: "FFmpeg could not be started."
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        const firstLine = output
          .split(/\r?\n/)
          .find((line) => line.startsWith("ffmpeg version"));

        finish({
          available: true,
          version: firstLine || "FFmpeg is installed.",
          error: null
        });
      } else {
        finish({
          available: false,
          version: null,
          error: "FFmpeg returned a non-zero exit code."
        });
      }
    });
  });
}

module.exports = { getFfmpegInfo };
