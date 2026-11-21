// =============================================
// L2S — Unified LLM Provider (Ollama or Groq)
// =============================================

import Groq from 'groq-sdk';

/**
 * Determine which LLM provider to use:
 * 'groq' if GROQ_API_KEY is present or explicit, else 'ollama'.
 */
export function getLLMConfig() {
  const provider = (process.env.LLM_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : 'ollama')).toLowerCase();
  const groqApiKey = process.env.GROQ_API_KEY || '';
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const ollamaModel = process.env.MODEL || 'llama3.2:3b';
  const whisperProvider = (process.env.WHISPER_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : 'local')).toLowerCase();
  const whisperModel = process.env.WHISPER_MODEL || (whisperProvider === 'groq' ? 'whisper-large-v3-turbo' : 'tiny.en');

  return {
    provider,
    groqApiKey,
    groqModel,
    ollamaUrl,
    ollamaModel,
    whisperProvider,
    whisperModel,
  };
}

/**
 * Universal text generation with LLM (Groq or Ollama)
 */
export async function queryLLM({
  prompt,
  systemPrompt,
  temperature = 0.3,
  maxTokens = 1000,
  jsonMode = false,
  customConfig = {},
}) {
  const config = { ...getLLMConfig(), ...customConfig };

  if (config.provider === 'groq' && config.groqApiKey) {
    try {
      const groq = new Groq({ apiKey: config.groqApiKey });
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const requestOptions = {
        model: config.groqModel,
        messages,
        temperature,
        max_tokens: Math.max(maxTokens, 1500),
      };

      if (jsonMode) {
        requestOptions.response_format = { type: 'json_object' };
      }

      const response = await groq.chat.completions.create(requestOptions);
      const choice = response.choices?.[0]?.message;
      return choice?.content || choice?.reasoning || '';
    } catch (err) {
      // If Groq fails and Ollama is available, we could attempt fallback or rethrow
      console.warn(`[LLM] Groq request failed (${err.message}). Trying Ollama fallback...`);
      return queryOllamaFallback(prompt, systemPrompt, config.ollamaUrl, config.ollamaModel, temperature);
    }
  }

  return queryOllamaFallback(prompt, systemPrompt, config.ollamaUrl, config.ollamaModel, temperature);
}

async function queryOllamaFallback(prompt, systemPrompt, ollamaUrl, model, temperature = 0.3) {
  const body = {
    model,
    prompt,
    stream: false,
    options: {
      temperature,
      num_predict: -1,
    },
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.response || '';
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
