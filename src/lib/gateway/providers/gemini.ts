/**
 * Gemini provider.
 *
 * The fund has a Google Workspace account and a Gemini API key, and no cloud
 * account of its own (operating facts), so this is the real production path. The
 * brief's Portkey and OpenRouter adapters sit behind the same Provider interface;
 * see portkey.ts and openrouter.ts, which activate only when their keys are set.
 */

import { GoogleGenAI } from '@google/genai';

import { ProviderError } from '../retry';
import type { ModelRequest, Provider } from '../types';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ProviderError('GEMINI_API_KEY is not set', undefined, false);
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

/** Map an SDK error onto something the retry policy can reason about. */
function toProviderError(error: unknown): ProviderError {
  const err = error as { status?: number; code?: number; message?: string };
  const status = err?.status ?? err?.code;
  const message = err?.message ?? String(error);
  // The SDK surfaces rate limits and transient faults as 429/5xx; everything else
  // is a request problem that retrying will not fix.
  const numeric = typeof status === 'number' ? status : undefined;
  return new ProviderError(message, numeric, numeric === 429);
}

export const geminiProvider: Provider = {
  name: 'gemini',

  async generate(model: string, req: ModelRequest) {
    const ai = getClient();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config: {
          systemInstruction: req.system,
          temperature: req.temperature ?? 0.2,
          ...(req.responseSchema
            ? {
                responseMimeType: 'application/json',
                responseSchema: req.responseSchema as never,
              }
            : {}),
        },
      });

      const text = response.text ?? '';
      const usage = response.usageMetadata;
      return {
        text,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  },

  async embed(model: string, texts: string[], dim = 768) {
    const ai = getClient();
    try {
      const response = await ai.models.embedContent({
        model,
        contents: texts,
        config: { outputDimensionality: dim },
      });
      return (response.embeddings ?? []).map((e) => e.values ?? []);
    } catch (error) {
      throw toProviderError(error);
    }
  },
};
