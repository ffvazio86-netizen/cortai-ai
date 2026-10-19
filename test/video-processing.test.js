import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
const canRun = process.platform === "linux" && ffmpegCheck.status === 0;

test("processa um vídeo de teste e disponibiliza três MP4 verticais", { skip: !canRun && "Requer Linux e FFmpeg (instalados no CI)." }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortai-e2e-"));
  let serverProcess;
  let baseUrl;
  let fixture;

  try {
    const fakeBin = path.join(temp, "bin");
    const dataDir = path.join(temp, "data");
    await mkdir(fakeBin, { recursive: true });

    fixture = path.join(temp, "fixture.mp4");
    const generated = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=1",
      "-t", "180", "-an", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", fixture
    ], { timeout: 120000, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || "Não foi possível criar o vídeo sintético de teste.");

    const fakeYtDlp = path.join(fakeBin, "yt-dlp");
    await writeFile(fakeYtDlp, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("yt-dlp test stub 1.0");
  process.exit(0);
}
const outputIndex = args.indexOf("-o");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error("Parâmetro -o ausente");
  process.exit(2);
}
const output = args[outputIndex + 1].replace("%(ext)s", "mp4");
fs.copyFileSync(process.env.CORTAI_FIXTURE_VIDEO, output);
`);
    await chmod(fakeYtDlp, 0o755);

    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));

    serverProcess = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        PORT: String(port),
        CORTAI_DATA_DIR: dataDir,
        CORTAI_FIXTURE_VIDEO: fixture,
        CORTAI_MAX_STORAGE_BYTES: String(5 * 1024 * 1024 * 1024),
        CORTAI_RESERVED_JOB_BYTES: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let logs = "";
    serverProcess.stdout.on("data", chunk => { logs += chunk.toString(); });
    serverProcess.stderr.on("data", chunk => { logs += chunk.toString(); });
    baseUrl = `http://127.0.0.1:${port}`;

    let healthy = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (serverProcess.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(healthy, true, `Servidor de teste não iniciou. Logs: ${logs}`);

    const startResponse = await fetch(`${baseUrl}/api/cuts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://youtu.be/test-fixture", authorized: true })
    });
    assert.equal(startResponse.status, 202, await startResponse.text());
    const { jobId } = await startResponse.json();
    let job;
    for (let attempt = 0; attempt < 240; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
      job = await response.json();
      if (job.status === "done" || job.status === "error") break;
    }

    assert.equal(job?.status, "done", `Geração de cortes falhou: ${job?.message || "tempo esgotado"}. Logs: ${logs}`);
    assert.equal(job.cuts.length, 3);
    for (const cut of job.cuts) {
      assert.equal(cut.durationSeconds, 60);
      const download = await fetch(new URL(cut.url, baseUrl));
      assert.equal(download.status, 200, `Falha ao baixar ${cut.name}`);
      assert.match(download.headers.get("content-type") || "", /video\/mp4/);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 1000, `${cut.name} parece vazio`);
      const outputFile = path.join(dataDir, "cuts", jobId, cut.name);
      const metadata = spawnSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0", outputFile
      ], { encoding: "utf8" });
      assert.equal(metadata.status, 0, metadata.stderr);
      assert.equal(metadata.stdout.trim(), "1080x1920");
    }
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await new Promise(resolve => {
        const timeout = setTimeout(() => { serverProcess.kill("SIGKILL"); resolve(); }, 3000);
        serverProcess.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    await rm(temp, { recursive: true, force: true });
  }
});
