import { execFile } from 'child_process';
import util from 'util';
import Groq from 'groq-sdk';
import { getLLMConfig } from './llm.js';

const execFileAsync = util.promisify(execFile);

export async function checkDependencies() {
  const llmConfig = getLLMConfig();
  const status = {
    ffmpeg: { installed: false, version: 'Missing' },
    ytdlp: { installed: false, version: 'Missing' },
    ollama: { installed: false, version: 'Missing' },
    groq: { installed: false, version: 'Missing' },
  };

  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    status.ffmpeg = { installed: true, version: stdout.split('\n')[0].substring(0, 30) };
  } catch (e) {}

  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--version']);
    status.ytdlp = { installed: true, version: stdout.trim() };
  } catch (e) {}

  try {
    const res = await fetch(`${llmConfig.ollamaUrl}/api/tags`);
    if (res.ok) {
      status.ollama = { installed: true, version: 'Connected' };
    }
  } catch (e) {}

  if (process.env.GROQ_API_KEY) {
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      // Quick verification of API key
      const models = await groq.models.list();
      if (models && models.data) {
        status.groq = { installed: true, version: `Connected (${llmConfig.groqModel})` };
      }
    } catch (e) {
      status.groq = { installed: false, version: `Error: ${e.message}` };
    }
  }

  return status;
}
