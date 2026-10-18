const { spawn } = require("node:child_process");

function probeVideo(filePath, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "json",
        filePath
      ], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish({ valid: false, unavailable: true });
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ valid: false, timeout: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) {
        child.kill("SIGKILL");
        finish({ valid: false });
      }
    });

    child.on("error", () => finish({ valid: false, unavailable: true }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ valid: false });
      try {
        const metadata = JSON.parse(output);
        const duration = Number(metadata.format?.duration);
        const hasVideoStream = Array.isArray(metadata.streams) &&
          metadata.streams.some((stream) => stream.codec_type === "video");
        finish({
          valid: hasVideoStream && Number.isFinite(duration) && duration > 0,
          duration: hasVideoStream && Number.isFinite(duration) && duration > 0
            ? duration
            : null
        });
      } catch {
        finish({ valid: false });
      }
    });
  });
}

module.exports = { probeVideo };
