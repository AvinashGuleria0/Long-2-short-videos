// =============================================
// SKATE — Transcriber (Whisper Bridge)
// =============================================

import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_WINDOWS = process.platform === "win32";
const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");

/**
 * Ensure audio is under Groq's 25MB upload limit by compressing to mp3 if needed
 */
function prepareAudioForGroq(audioPath) {
  const stat = fs.statSync(audioPath);
  const sizeMB = stat.size / (1024 * 1024);

  // If already under 24MB and not a massive WAV, return as is
  if (sizeMB < 24 && !audioPath.toLowerCase().endsWith('.wav')) {
    return audioPath;
  }

  // Compress to mp3 (mono, 64kbps) which stays ~0.5MB per minute (a 45-min video is under 23MB)
  const dir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const compressedPath = path.join(dir, `${baseName}-groq.mp3`);

  if (fs.existsSync(compressedPath)) {
    return compressedPath;
  }

  const result = spawnSync("ffmpeg", [
    "-i", audioPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    "-y",
    compressedPath
  ], {
    timeout: 300000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.status === 0 && fs.existsSync(compressedPath)) {
    return compressedPath;
  }

  return audioPath;
}

/**
 * Find the Python executable
 */
function findPython() {
  // Try venv first
  const venvPython = IS_WINDOWS
    ? path.join(os.homedir(), ".skate", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".skate", "venv", "bin", "python3");

  if (fs.existsSync(venvPython)) return venvPython;

  // Fall back to system Python
  return IS_WINDOWS ? "python" : "python3";
}

/**
 * Transcribe audio using Groq Whisper API or fallback to local faster-whisper
 */
export async function transcribeAudio(audioPath, cacheDir, modelSize = "base", onProgress, options = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });

  const whisperProvider = options.whisperProvider || (process.env.WHISPER_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : 'local'));
  const whisperModel = options.whisperModel || (whisperProvider === 'groq' ? 'whisper-large-v3-turbo' : modelSize);

  // Check cache
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const cacheFile = path.join(cacheDir, `${baseName}.${whisperProvider}.${whisperModel}.transcript.json`);

  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    const totalWords = (cached.segments || []).reduce((acc, s) => acc + (s.words?.length || 0), 0);
    if (totalWords > 0) {
      console.log(`[Transcriber] Loaded ${totalWords} words from transcript cache: ${path.basename(cacheFile)}`);
      return cached;
    }
    console.log(`[Transcriber] Cached transcript had 0 words; invalidating cache and re-synthesizing words.`);
  }

  // Use Groq if selected & key available
  if (whisperProvider === 'groq' && process.env.GROQ_API_KEY) {
    if (typeof onProgress === 'function') onProgress(`Using lightning-fast Groq Whisper API (${whisperModel})...`);
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const readyAudio = prepareAudioForGroq(audioPath);
      
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(readyAudio),
        model: whisperModel,
        response_format: "verbose_json",
        timestamp_granularities: ["segment", "word"],
      });
      
      const rawWords = transcription.words || [];

      // Check if Groq returned word-level timestamps; if empty, synthesize word-level timestamps from segments
      const segments = (transcription.segments || []).map(seg => {
        let segWords = rawWords.filter(w => w.start >= seg.start - 0.05 && w.end <= seg.end + 0.15);
        if (segWords.length === 0 && (seg.text || '').trim()) {
          const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
          const dur = Math.max(0.1, seg.end - seg.start);
          const step = dur / tokens.length;
          segWords = tokens.map((token, idx) => ({
            word: token,
            start: Number((seg.start + idx * step).toFixed(2)),
            end: Number((seg.start + (idx + 1) * step).toFixed(2)),
          }));
        }
        return {
          start: seg.start,
          end: seg.end,
          text: seg.text,
          words: segWords,
        };
      });

      const transcript = {
        language: transcription.language || "unknown",
        duration: transcription.duration || 0,
        segments,
      };
      
      fs.writeFileSync(cacheFile, JSON.stringify(transcript, null, 2));
      return transcript;
    } catch (e) {
      if (typeof onProgress === 'function') onProgress(`Groq Whisper failed: ${e.message}. Falling back to local...`);
    }
  }

  const python = findPython();
  const script = path.join(SCRIPTS_DIR, "whisper_transcribe.py");

  if (!fs.existsSync(script)) {
    throw new Error(`Whisper script not found at: ${script}`);
  }

  // Use async spawn to avoid blocking Node.js event loop
  const raw = await new Promise((resolve, reject) => {
    import("child_process").then(({ spawn }) => {
      const child = spawn(python, [script, audioPath, modelSize], {
        windowsHide: true,
      });

      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", (data) => {
        stdoutData += data.toString();
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderrData += text;
        
        // Try to parse real-time progress from stderr
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.includes("Transcribed:") && typeof onProgress === 'function') {
            onProgress(line.trim());
          }
        }
      });

      child.on("close", (code) => {
        if (code !== 0) {
          return reject(new Error(`Transcription failed: ${stderrData.trim() || stdoutData.trim() || "Exit code " + code}`));
        }
        try {
          resolve(JSON.parse(stdoutData.trim()));
        } catch (e) {
          reject(new Error(`Transcription failed: Could not parse output as JSON`));
        }
      });

      child.on("error", (err) => {
        reject(new Error(`Transcription failed: Could not run Python — ${err.message}`));
      });
    });
  });

  if (raw.error) {
    throw new Error(`Transcription error: ${raw.error}`);
  }

  const segments = (raw.segments || []).map((seg) => ({
    start: seg.start ?? 0,
    end: seg.end ?? 0,
    text: (seg.text || "").trim(),
    words: (seg.words || []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
  }));

  const transcript = {
    segments,
    language: raw.language || "unknown",
    duration: raw.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0),
  };

  // Cache result
  fs.writeFileSync(cacheFile, JSON.stringify(transcript, null, 2));
  return transcript;
}
