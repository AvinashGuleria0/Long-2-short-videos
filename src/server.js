// =============================================
// SKATE — Express + WebSocket Server
// =============================================

import express from 'express';
import { WebSocketServer } from 'ws';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import archiver from 'archiver';
import { getLLMConfig } from './llm.js';
import { runPipeline, stopPipeline, getPipelineState } from './pipeline.js';
import { runDemoPipeline } from './demo.js';
import { checkDependencies } from './doctor.js';
import { renderClips } from './renderer.js';
import {
  getYouTubeAuthUrl, exchangeYouTubeCode,
  getInstagramAuthUrl, exchangeInstagramCode,
  getConnectionStatus, getCredentialStatus,
  disconnectPlatform,
} from './auth.js';
import { publishClips } from './uploader.js';

// ─── Load .env manually (no extra dependency) ────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

try {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (e) { /* ignore */ }

// ─── App Setup ───────────────────────────────────────
const app = express();
app.use(express.json());

// Serve static files
app.use(express.static(path.join(rootDir, 'public')));
app.use('/output', express.static(path.join(rootDir, 'output')));
app.use('/temp', express.static(path.join(rootDir, 'temp')));

// Serve raw video for the Live Editor
app.get('/api/raw_video', (req, res) => {
  const state = getPipelineState();
  let videoPath = state?.videoPath;

  // Fallback: If server restarted and state is lost, find latest .mp4 in temp dir
  if (!videoPath || !fs.existsSync(videoPath)) {
    const tempDir = path.join(rootDir, 'temp');
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.mp4'));
      if (files.length > 0) {
        files.sort((a, b) => fs.statSync(path.join(tempDir, b)).mtimeMs - fs.statSync(path.join(tempDir, a)).mtimeMs);
        videoPath = path.join(tempDir, files[0]);
      }
    }
  }

  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).send('Raw video not available');
  }
  
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(videoPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(videoPath).pipe(res);
  }
});

// Ensure directories exist
fs.mkdirSync(path.join(rootDir, 'output'), { recursive: true });
fs.mkdirSync(path.join(rootDir, 'temp'), { recursive: true });

// ─── WebSocket ───────────────────────────────────────
const clients = new Set();
let isProcessing = false;

const broadcast = (message) => {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
};

// ─── API Routes ──────────────────────────────────────

/**
 * GET /api/models — Return available LLM and Whisper models
 */
app.get('/api/models', async (req, res) => {
  const llmConfig = getLLMConfig();
  const models = {
    current: {
      provider: llmConfig.provider,
      llmModel: llmConfig.provider === 'groq' ? llmConfig.groqModel : llmConfig.ollamaModel,
      whisperProvider: llmConfig.whisperProvider,
      whisperModel: llmConfig.whisperModel,
    },
    groqModels: [
      { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B (Groq - Fast & Balanced)' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B (Groq - High Quality)' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (Groq - Multilingual)' },
      { id: 'allam-2-7b', label: 'Allam 2 7B (Groq - Lightweight)' }
    ],
    ollamaModels: [
      { id: 'llama3.2:3b', label: 'Llama 3.2 3B (Local Ollama)' },
      { id: 'llama3.1:8b', label: 'Llama 3.1 8B (Local Ollama)' },
      { id: 'mistral', label: 'Mistral 7B (Local Ollama)' }
    ],
    whisperModels: [
      { id: 'whisper-large-v3-turbo', provider: 'groq', label: 'Whisper Large v3 Turbo (Groq Cloud - Lightning Fast)' },
      { id: 'whisper-large-v3', provider: 'groq', label: 'Whisper Large v3 (Groq Cloud - Maximum Accuracy)' },
      { id: 'tiny.en', provider: 'local', label: 'Whisper Tiny (Local faster-whisper - Lightweight)' },
      { id: 'base', provider: 'local', label: 'Whisper Base (Local faster-whisper)' },
      { id: 'small', provider: 'local', label: 'Whisper Small (Local faster-whisper)' }
    ]
  };

  // If Ollama is running, query its real installed models
  try {
    const ollamaRes = await fetch(`${llmConfig.ollamaUrl}/api/tags`);
    if (ollamaRes.ok) {
      const data = await ollamaRes.json();
      if (data.models && data.models.length > 0) {
        models.ollamaModels = data.models.map(m => ({ id: m.name, label: `${m.name} (Local Ollama)` }));
      }
    }
  } catch (e) {}

  res.json(models);
});

/**
 * POST /api/set-models — Save current session model preference
 */
app.post('/api/set-models', (req, res) => {
  const { provider, llmModel, whisperProvider, whisperModel } = req.body;
  if (provider) process.env.LLM_PROVIDER = provider;
  if (llmModel) {
    if (provider === 'groq') process.env.GROQ_MODEL = llmModel;
    else process.env.MODEL = llmModel;
  }
  if (whisperProvider) process.env.WHISPER_PROVIDER = whisperProvider;
  if (whisperModel) process.env.WHISPER_MODEL = whisperModel;

  res.json({ success: true, current: getLLMConfig() });
});

/**
 * GET /api/download-zip — Download all rendered clips & captions in a zip
 */
app.get('/api/download-zip', (req, res) => {
  const state = getPipelineState();
  let videoName = req.query.video;

  if (!videoName && state?.videoPath) {
    videoName = path.basename(state.videoPath, path.extname(state.videoPath));
  }

  // Fallback: latest folder in output
  const outputDir = path.join(rootDir, 'output');
  if (!videoName && fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .sort((a, b) => fs.statSync(path.join(outputDir, b.name)).mtimeMs - fs.statSync(path.join(outputDir, a.name)).mtimeMs);
    if (entries.length > 0) videoName = entries[0].name;
  }

  if (!videoName) {
    return res.status(404).send('No rendered project available');
  }

  const projectDir = path.join(outputDir, videoName);
  if (!fs.existsSync(projectDir)) {
    return res.status(404).send('Rendered directory not found');
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  res.attachment(`${videoName}-clips.zip`);

  archive.on('error', (err) => {
    res.status(500).send({ error: err.message });
  });

  archive.pipe(res);
  archive.directory(projectDir, false);
  archive.finalize();
});
app.get('/api/status', async (req, res) => {
  const status = await checkDependencies();
  res.json(status);
});

/**
 * POST /api/video-info — Fetch YouTube video metadata
 */
app.post('/api/video-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    // Try with extractor-args first (avoids 403)
    let result = spawnSync('yt-dlp', [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=mediaconnect',
      '--no-check-certificates',
      url,
    ], {
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Fallback: try with cookies
    if (result.error || result.status !== 0) {
      result = spawnSync('yt-dlp', [
        '--dump-json',
        '--no-download',
        '--no-warnings',
        '--cookies-from-browser', 'chrome',
        '--no-check-certificates',
        url,
      ], {
        timeout: 30000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    if (result.error || result.status !== 0) {
      return res.status(400).json({ error: 'Could not fetch video info. Check the URL.' });
    }

    const info = JSON.parse(result.stdout.trim());
    res.json({
      title: info.title || 'Unknown',
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
      duration: info.duration || 0,
      channel: info.uploader || info.channel || 'Unknown',
      viewCount: info.view_count || 0,
      description: (info.description || '').slice(0, 200),
    });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse video info' });
  }
});

/**
 * POST /api/process — Start the clip generation pipeline
 */
app.post('/api/process', async (req, res) => {
  if (isProcessing) {
    return res.status(409).json({ error: 'Pipeline already running. Stop it first.' });
  }

  const { source, genre, description, timestamps, clipMode, llmProvider, llmModel, whisperProvider, whisperModel, quality } = req.body;
  if (!source) return res.status(400).json({ error: 'Source URL is required' });

  isProcessing = true;
  res.json({ success: true, message: 'Pipeline started' });

  // Check dependencies to decide real vs demo mode
  const deps = await checkDependencies();
  const selectedProvider = llmProvider || (deps.groq.installed ? 'groq' : 'ollama');
  const hasLLM = (selectedProvider === 'groq' && deps.groq.installed) || (selectedProvider === 'ollama' && deps.ollama.installed) || deps.groq.installed || deps.ollama.installed;
  const hasAllTools = deps.ffmpeg.installed && deps.ytdlp.installed && hasLLM;

  broadcast({ type: 'log', level: 'info', msg: `🛹 Starting L2S pipeline for: ${source}` });
  broadcast({ type: 'log', level: 'info', msg: `🎯 Genre: ${genre || 'auto-detect'} | Quality: ${quality || '1080p'}` });
  broadcast({ type: 'log', level: 'info', msg: `🤖 LLM: ${selectedProvider.toUpperCase()} (${llmModel || 'default'})` });
  broadcast({ type: 'log', level: 'info', msg: `🎤 Whisper: ${(whisperProvider || 'auto').toUpperCase()} (${whisperModel || 'auto'})` });

  if (description) {
    broadcast({ type: 'log', level: 'info', msg: `📝 Description filter: "${description}"` });
  }
  if (timestamps && timestamps.length > 0) {
    broadcast({ type: 'log', level: 'info', msg: `⏱️  Manual timestamps: ${timestamps.length} ranges provided` });
  }
  if (clipMode === 'only' && (description || (timestamps && timestamps.length > 0))) {
    broadcast({ type: 'log', level: 'info', msg: `🎯 Mode: Only description/timestamp clips (skipping AI ranking)` });
  }

  if (!hasAllTools) {
    const missing = [];
    if (!deps.ffmpeg.installed) missing.push('FFmpeg');
    if (!deps.ytdlp.installed) missing.push('yt-dlp');
    if (!hasLLM) missing.push('Ollama or Groq API Key');
    broadcast({ type: 'log', level: 'warning', msg: `⚠️  Missing: ${missing.join(', ')} — Running in DEMO mode` });
    broadcast({ type: 'log', level: 'info', msg: '💡 Install missing tools or configure GROQ_API_KEY for real processing' });
  } else {
    broadcast({ type: 'log', level: 'success', msg: '✅ All tools detected — Running FULL pipeline' });
  }

  try {
    if (hasAllTools) {
      await runPipeline(source, genre, broadcast, rootDir, {
        description,
        timestamps,
        clipMode,
        llmProvider,
        llmModel,
        whisperProvider,
        whisperModel,
        quality,
      });
    } else {
      await runDemoPipeline(source, genre, broadcast);
    }
    broadcast({ type: 'done' });
  } catch (err) {
    if (err.message === 'PIPELINE_CANCELLED') {
      broadcast({ type: 'stopped' });
    } else {
      broadcast({ type: 'error', msg: err.message, step: 'error' });
    }
  } finally {
    isProcessing = false;
  }
});

/**
 * POST /api/stop — Cancel a running pipeline
 */
app.post('/api/stop', (req, res) => {
  if (!isProcessing) {
    return res.json({ success: true, message: 'Nothing to stop' });
  }
  stopPipeline();
  isProcessing = false;
  broadcast({ type: 'log', level: 'warning', msg: '🛑 Pipeline cancelled by user' });
  broadcast({ type: 'stopped' });
  res.json({ success: true, message: 'Pipeline stopping...' });
});

/**
 * POST /api/render — Render selected clips with FFmpeg
 */
app.post('/api/render', async (req, res) => {
  const { selectedIndices, selectedClipsData, customOutputDir } = req.body;
  const state = getPipelineState();

  if (!state || !state.videoPath || !state.selected) {
    return res.status(400).json({ error: 'No pipeline data. Run the pipeline first.' });
  }

  res.json({ success: true, message: 'Rendering started' });

  broadcast({ type: 'step', step: 'render', status: 'active' });
  broadcast({ type: 'log', level: 'info', msg: '🎬 Starting clip rendering with FFmpeg...' });

  try {
    // Determine which clips to render and merge any custom editor settings
    const indices = selectedIndices || state.selected.map((_, i) => i);
    const toRender = indices
      .map((clipIndex, arrayIndex) => {
        const baseClip = state.selected[clipIndex];
        if (!baseClip) return null;
        // Merge frontend editor adjustments if available
        const customData = selectedClipsData && selectedClipsData[arrayIndex] ? selectedClipsData[arrayIndex] : {};
        return { ...baseClip, custom: customData };
      })
      .filter(Boolean);

    if (toRender.length === 0) {
      throw new Error('No valid clips selected for rendering');
    }

    broadcast({ type: 'log', level: 'info', msg: `🎞️  Rendering ${toRender.length} clips...` });

    // Create output directory named after the video
    const videoName = path.basename(state.videoPath, path.extname(state.videoPath));
    const baseDir = customOutputDir && fs.existsSync(customOutputDir) ? customOutputDir : path.join(rootDir, 'output');
    const outputDir = path.join(baseDir, videoName);

    await renderClips(state.videoPath, toRender, 'tiktok', outputDir, (msg) => {
      broadcast({ type: 'log', level: 'info', msg: `  ${msg}` });
    });

    // Collect rendered files
    const clipsDir = path.join(outputDir, 'clips');
    let renderedFiles = [];
    if (fs.existsSync(clipsDir)) {
      renderedFiles = fs.readdirSync(clipsDir)
        .filter(f => f.endsWith('.mp4'))
        .sort()
        .map(f => `/output/${videoName}/clips/${f}`);
    }

    broadcast({ type: 'log', level: 'success', msg: `✅ Rendered ${renderedFiles.length} clips successfully!` });
    broadcast({ type: 'step', step: 'render', status: 'done' });

    // Send rendered file URLs to frontend
    broadcast({
      type: 'render_done',
      files: renderedFiles,
      outputDir: `/output/${videoName}`,
    });

  } catch (err) {
    broadcast({ type: 'step', step: 'render', status: 'error' });
    broadcast({ type: 'error', msg: `Render failed: ${err.message}` });
  }
});

/**
 * POST /api/re-render — Re-render a single clip after editing
 */
app.post('/api/re-render', async (req, res) => {
  const { clipIndex, clipData } = req.body;
  const state = getPipelineState();

  if (!state || !state.videoPath) {
    return res.status(400).json({ error: 'No pipeline data. Run the pipeline first.' });
  }

  const clip = clipData || (state.selected && state.selected[clipIndex]) || (state.clipsWithMeta && state.clipsWithMeta[clipIndex]);
  if (!clip) {
    return res.status(400).json({ error: 'Clip data not found for re-rendering' });
  }

  res.json({ success: true, message: 'Re-rendering clip...' });

  try {
    const videoName = path.basename(state.videoPath, path.extname(state.videoPath));
    const outputDir = path.join(rootDir, 'output', videoName);
    const clipsDir = path.join(outputDir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });

    const clipNum = String(clipIndex + 1).padStart(2, '0');

    // Build the clip object for rendering, supporting both clip.start and clip.chunk.start
    const chunkStart = clip.start ?? clip.chunk?.start ?? 0;
    const chunkEnd = clip.end ?? clip.chunk?.end ?? 0;
    const chunkText = clip.text ?? clip.chunk?.text ?? '';
    const chunkWords = clip.words ?? clip.chunk?.words ?? [];

    const chunk = {
      start: chunkStart,
      end: chunkEnd,
      text: chunkText,
      words: chunkWords,
    };

    const toRender = [{
      chunk,
      custom: {
        ...clip,
        editStart: clip.editStart ?? chunkStart,
        editEnd: clip.editEnd ?? chunkEnd,
      },
    }];

    broadcast({ type: 'log', level: 'info', msg: `🔄 Re-rendering clip ${clipNum}...` });

    await renderClips(state.videoPath, toRender, 'tiktok', outputDir, (msg) => {
      broadcast({ type: 'log', level: 'info', msg: `  ${msg}` });
    });

    const fileUrl = `/output/${videoName}/clips/clip-01.mp4`;

    // Rename the re-rendered file to the correct clip number
    const renderedPath = path.join(clipsDir, 'clip-01.mp4');
    const targetPath = path.join(clipsDir, `clip-${clipNum}.mp4`);
    if (clipNum !== '01' && fs.existsSync(renderedPath)) {
      fs.renameSync(renderedPath, targetPath);
    }

    const finalUrl = `/output/${videoName}/clips/clip-${clipNum}.mp4`;

    broadcast({ type: 'log', level: 'success', msg: `✅ Clip ${clipNum} re-rendered!` });
    broadcast({
      type: 're_render_done',
      clipIndex,
      fileUrl: finalUrl,
    });

  } catch (err) {
    broadcast({ type: 'error', msg: `Re-render failed: ${err.message}` });
  }
});

/**
 * POST /api/set-output-dir — Validate and set custom output directory
 */
app.post('/api/set-output-dir', (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'Path is required' });

  const resolved = path.resolve(dirPath);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    if (fs.existsSync(resolved)) {
      return res.json({ success: true, path: resolved });
    }
    return res.status(400).json({ error: 'Could not create directory' });
  } catch (e) {
    return res.status(400).json({ error: `Invalid path: ${e.message}` });
  }
});

/**
 * POST /api/publish-clip — Publish a single clip to a platform
 */
app.post('/api/publish-clip', async (req, res) => {
  const { clip, fileUrl, platform, workflow } = req.body;
  if (!clip || !fileUrl || !platform) {
    return res.status(400).json({ error: 'clip, fileUrl, and platform are required' });
  }

  const connections = getConnectionStatus();
  if (!connections[platform]?.connected) {
    return res.json({ success: false, message: `${platform} not connected` });
  }

  res.json({ success: true, message: `Publishing to ${platform}...` });

  const activeWorkflow = { youtube: null, instagram: null };
  activeWorkflow[platform] = workflow || {};

  try {
    const result = await publishClips([clip], [fileUrl], activeWorkflow, rootDir, broadcast);
    broadcast({ type: 'publish_done', results: result.results, summary: result.summary });
  } catch (err) {
    broadcast({ type: 'log', level: 'error', msg: `❌ Publish error: ${err.message}` });
    broadcast({ type: 'publish_done', results: [], summary: { total: 0, success: 0, failed: 1 } });
  }
});

/**
 * GET /api/connection-status — Check social media connection status
 */
app.get('/api/connection-status', (req, res) => {
  const connections = getConnectionStatus();
  const credentials = getCredentialStatus();
  res.json({ connections, credentials });
});

/**
 * POST /api/connect/:platform — Start OAuth flow for a platform
 */
app.post('/api/connect/:platform', (req, res) => {
  const { platform } = req.params;
  const port = process.env.PORT || 3000;

  if (platform === 'youtube') {
    const redirectUri = `http://localhost:${port}/api/auth/callback/youtube`;
    const authUrl = getYouTubeAuthUrl(redirectUri);
    if (!authUrl) {
      return res.json({
        success: false,
        needsSetup: true,
        message: 'YouTube OAuth not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to your .env file.',
      });
    }
    return res.json({ success: false, authUrl, message: 'Redirecting to Google login...' });
  }

  if (platform === 'instagram') {
    const redirectUri = `http://localhost:${port}/api/auth/callback/instagram`;
    const authUrl = getInstagramAuthUrl(redirectUri);
    if (!authUrl) {
      return res.json({
        success: false,
        needsSetup: true,
        message: 'Instagram OAuth not configured. Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to your .env file.',
      });
    }
    return res.json({ success: false, authUrl, message: 'Redirecting to Facebook login...' });
  }

  res.status(400).json({ error: `Unknown platform: ${platform}` });
});

/**
 * GET /api/auth/callback/youtube — YouTube OAuth callback
 */
app.get('/api/auth/callback/youtube', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(authResultPage('YouTube', false, error || 'No authorization code received'));
  }
  try {
    const port = process.env.PORT || 3000;
    const redirectUri = `http://localhost:${port}/api/auth/callback/youtube`;
    const tokenData = await exchangeYouTubeCode(code, redirectUri);
    broadcast({ type: 'log', level: 'success', msg: `✅ YouTube connected as: ${tokenData.username}` });
    broadcast({ type: 'connection_update', platform: 'youtube', connected: true, username: tokenData.username });
    res.send(authResultPage('YouTube', true, null, tokenData.username));
  } catch (e) {
    broadcast({ type: 'log', level: 'error', msg: `❌ YouTube auth failed: ${e.message}` });
    res.send(authResultPage('YouTube', false, e.message));
  }
});

/**
 * GET /api/auth/callback/instagram — Instagram OAuth callback
 */
app.get('/api/auth/callback/instagram', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(authResultPage('Instagram', false, error || 'No authorization code received'));
  }
  try {
    const port = process.env.PORT || 3000;
    const redirectUri = `http://localhost:${port}/api/auth/callback/instagram`;
    const tokenData = await exchangeInstagramCode(code, redirectUri);
    broadcast({ type: 'log', level: 'success', msg: `✅ Instagram connected as: ${tokenData.username}` });
    broadcast({ type: 'connection_update', platform: 'instagram', connected: true, username: tokenData.username });
    res.send(authResultPage('Instagram', true, null, tokenData.username));
  } catch (e) {
    broadcast({ type: 'log', level: 'error', msg: `❌ Instagram auth failed: ${e.message}` });
    res.send(authResultPage('Instagram', false, e.message));
  }
});

/**
 * POST /api/disconnect/:platform — Disconnect a platform
 */
app.post('/api/disconnect/:platform', (req, res) => {
  const { platform } = req.params;
  disconnectPlatform(platform);
  broadcast({ type: 'connection_update', platform, connected: false });
  broadcast({ type: 'log', level: 'info', msg: `🔌 ${platform} disconnected` });
  res.json({ success: true });
});

/**
 * POST /api/publish — Publish clips to connected platforms
 */
app.post('/api/publish', async (req, res) => {
  const { clips, files, workflow } = req.body;
  if (!clips || clips.length === 0) {
    return res.status(400).json({ error: 'No clips to publish' });
  }

  const connections = getConnectionStatus();
  const platforms = [];
  if (workflow?.youtube && connections.youtube.connected) platforms.push('YouTube');
  if (workflow?.instagram && connections.instagram.connected) platforms.push('Instagram');

  if (platforms.length === 0) {
    return res.json({
      success: false,
      message: 'No connected platforms. Connect YouTube or Instagram first.',
      published: 0,
    });
  }

  res.json({ success: true, message: `Publishing to ${platforms.join(' & ')}...` });

  const activeWorkflow = {
    youtube: (workflow?.youtube && connections.youtube.connected) ? workflow.youtube : null,
    instagram: (workflow?.instagram && connections.instagram.connected) ? workflow.instagram : null,
  };

  try {
    const result = await publishClips(clips, files, activeWorkflow, rootDir, broadcast);
    broadcast({ type: 'publish_done', results: result.results, summary: result.summary });
  } catch (err) {
    broadcast({ type: 'log', level: 'error', msg: `❌ Publish error: ${err.message}` });
    broadcast({ type: 'publish_done', results: [], summary: { total: 0, success: 0, failed: clips.length } });
  }
});

/** Generate HTML page for OAuth callback result */
function authResultPage(platform, success, error, username) {
  const emoji = success ? '✅' : '❌';
  const msg = success
    ? `Connected to ${platform} as ${username || 'User'}!`
    : `Failed to connect ${platform}: ${error || 'Unknown error'}`;
  const bg = success ? '#0a2e1a' : '#2e0a0a';
  const border = success ? '#10b981' : '#ef4444';
  const glow = success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
  const usernameJs = username ? `'${username.replace(/'/g, "\\'")}'` : 'null';
  const errorJs = error ? `'${error.replace(/'/g, "\\'")}'` : 'null';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${platform} — ${success ? 'Connected' : 'Error'}</title>
<style>body{background:#06060a;color:#f0f0f5;font-family:'Inter',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:${bg};border:1px solid ${border};border-radius:16px;padding:40px;text-align:center;max-width:400px;box-shadow:0 0 30px ${glow}}
.emoji{font-size:3rem;margin-bottom:16px}h2{margin:0 0 8px;font-size:1.3rem}p{color:#8a8a9e;font-size:0.9rem;margin:0}</style></head>
<body><div class="card"><div class="emoji">${emoji}</div><h2>${msg}</h2><p>This window will close automatically...</p></div>
<script>if(window.opener){window.opener.postMessage({type:'oauth_callback',platform:'${platform.toLowerCase()}',success:${success},username:${usernameJs},error:${errorJs}},'*')}
setTimeout(()=>window.close(),2000)</script></body></html>`;
}

// ─── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n  🛹 L2S is running on http://localhost:${PORT}\n`);
  console.log(`  Turn long-form videos into viral shorts — 100% local, 100% free\n`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});
