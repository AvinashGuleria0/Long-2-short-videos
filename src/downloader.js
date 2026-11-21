// =============================================
// SKATE — Downloader (yt-dlp + FFmpeg)
// Fixed: 403 errors, cookies, retry logic
// =============================================

import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

// Detect user's default browser or cookies.txt file for cookie extraction
function getCookieArgs() {
  // 1. Check if a cookies.txt file exists in the project root or temp directory
  const rootCookies = path.resolve("cookies.txt");
  if (fs.existsSync(rootCookies)) {
    console.log(`[Downloader] Using custom cookies file: ${rootCookies}`);
    return ["--cookies", rootCookies];
  }

  // 2. Try detected browser cookies (e.g. Chrome, Edge, Firefox, Brave)
  const browsers = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'chromium'];
  for (const browser of browsers) {
    try {
      const test = spawnSync("yt-dlp", ["--cookies-from-browser", browser, "--version"], {
        timeout: 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      if (test.status === 0) {
        return ["--cookies-from-browser", browser];
      }
    } catch (e) { /* continue */ }
  }
  return null;
}

/**
 * Download video from YouTube using yt-dlp
 * Handles 403 errors with retry strategies:
 * 1. Default download
 * 2. With browser cookies
 * 3. With Android player client
 * 4. Audio-only fallback
 */
export async function downloadVideo(url, outputDir, onLog, quality = "1080p") {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");

  const heightLimit = quality === "720p" ? 720 : (quality === "4k" ? 2160 : 1080);
  const formatSelector = `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]/best`;
  const cookieArgs = getCookieArgs();

  console.log(`[Downloader] Starting download for: ${url} (Target Quality: ${quality}, height limit: ${heightLimit}p)`);

  // Strategy list — try updated modern default client first, then Web/iOS/VR, then Cookies
  const strategies = [
    {
      name: "Modern Default Client (HD/4K stream)",
      args: [
        "-f", formatSelector,
        "--force-overwrites",
        "--merge-output-format", "mp4",
        "--no-check-certificates",
        "-o", outputTemplate,
        url,
      ],
    },
    {
      name: "Android VR + Web client",
      args: [
        "-f", formatSelector,
        "--force-overwrites",
        "--merge-output-format", "mp4",
        "--extractor-args", "youtube:player_client=android_vr,web",
        "--no-check-certificates",
        "-o", outputTemplate,
        url,
      ],
    },
    {
      name: "iOS client (HD stream)",
      args: [
        "-f", formatSelector,
        "--force-overwrites",
        "--merge-output-format", "mp4",
        "--extractor-args", "youtube:player_client=ios,web",
        "--no-check-certificates",
        "-o", outputTemplate,
        url,
      ],
    },
    ...(cookieArgs ? [{
      name: `Authentication Cookies (${cookieArgs.join(" ")})`,
      args: [
        "-f", formatSelector,
        "--force-overwrites",
        "--merge-output-format", "mp4",
        ...cookieArgs,
        "--no-check-certificates",
        "-o", outputTemplate,
        url,
      ],
    }] : []),
  ];

  let lastError = "";

  for (const strategy of strategies) {
    if (onLog) onLog(`Trying: ${strategy.name}...`);

    const result = spawnSync("yt-dlp", strategy.args, {
      timeout: 600000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    if (result.error) {
      lastError = result.error.message;
      continue;
    }

    if (result.status !== 0) {
      lastError = (result.stderr || "").trim();
      // If it's a 403 error, try next strategy
      if (lastError.includes("403") || lastError.includes("Forbidden")) {
        if (onLog) onLog(`Strategy "${strategy.name}" got 403, trying next...`);
        continue;
      }
      // Other errors — also try next
      continue;
    }

    // Success — find the output file
    const stdout = (result.stdout || "").trim();
    console.log(`[Downloader] Download completed successfully with strategy: ${strategy.name}`);
    const outputPath = stdout.split("\n").pop() || "";

    let finalFile = null;
    if (outputPath) {
      const normalizedPath = path.normalize(outputPath.trim());
      if (fs.existsSync(normalizedPath)) {
        finalFile = normalizedPath;
      }
    }

    if (!finalFile) {
      finalFile = findLatestVideo(outputDir);
    }

    if (finalFile) {
      try {
        const probe = spawnSync("ffprobe", [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,codec_name",
          "-of", "json",
          finalFile
        ], { encoding: "utf-8" });
        if (probe.status === 0) {
          const probeData = JSON.parse(probe.stdout);
          const vstream = probeData.streams?.[0];
          if (vstream) {
            console.log(`[Downloader] Verified stream resolution: ${vstream.width}x${vstream.height} (${vstream.codec_name})`);
            if (onLog) onLog(`Resolution: ${vstream.width}x${vstream.height} (${vstream.codec_name})`);
          }
        }
      } catch (e) { /* ignore probe failure */ }
      return finalFile;
    }
  }

  // All strategies failed
  throw new Error(
    `Download failed after trying all strategies.\n` +
    `Last error: ${lastError}\n\n` +
    `💡 Try these fixes:\n` +
    `   1. Update yt-dlp: pip install --upgrade yt-dlp\n` +
    `   2. Make sure you're logged into YouTube in Chrome/Edge\n` +
    `   3. Try a different video URL\n` +
    `   4. Check if the video is available in your region`
  );
}

/**
 * Extract audio from video using FFmpeg
 */
export async function extractAudio(videoPath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioFile = path.join(outputDir, `${baseName}.wav`);

  // Skip if already extracted
  if (fs.existsSync(audioFile)) {
    return audioFile;
  }

  const result = spawnSync("ffmpeg", [
    "-i", videoPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-y",
    audioFile,
  ], {
    timeout: 600000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Audio extraction failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`Audio extraction failed: ${stderr || "ffmpeg exited with code " + result.status}`);
  }

  if (!fs.existsSync(audioFile)) {
    throw new Error(`Audio extraction completed but file not found at: ${audioFile}`);
  }

  return audioFile;
}

/**
 * Find the latest video file in a directory
 */
function findLatestVideo(dir) {
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith(".mp4") || f.endsWith(".webm") || f.endsWith(".mkv")
  );

  if (files.length === 0) return null;

  files.sort((a, b) => {
    const statA = fs.statSync(path.join(dir, a));
    const statB = fs.statSync(path.join(dir, b));
    return statB.mtimeMs - statA.mtimeMs;
  });

  return path.join(dir, files[0]);
}
