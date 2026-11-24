/**
 * OpenRouter — the production path (brief §3: "in production, call OpenRouter
 * directly").
 *
 * Two things this provider cannot do, recorded here rather than discovered later:
 *
 *  1. **No embeddings.** OpenRouter serves chat completions only; there is no
 *     embedding model in its catalogue. Everything in this system that uses
 *     pgvector — memo retrieval, the G3 portfolio conflict check, style examples,
 *     remembered corrections — needs a vector from somewhere else. `embed()` here
 *     throws rather than returning a plausible-looking array, because a silently
 *     wrong vector makes the conflict check appear to work while matching nothing.
 *
 *  2. **No guarantee a model honoured the JSON schema.** `response_format` is
 *     passed upstream and may be ignored. Downstream quote verification and
 *     citation checks are what actually enforce structure.
 */

import { generateCompatible } from './openai-compatible';
import { ProviderError } from '../retry';
import type { ModelRequest, Provider } from '../types';

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new ProviderError('OPENROUTER_API_KEY is not set', undefined, false);
  return key;
}

export const openrouterProvider: Provider = {
  name: 'openrouter',

  async generate(model: string, req: ModelRequest) {
    return generateCompatible(
      {
        name: 'openrouter',
        baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        apiKey: apiKey(),
        headers: {
          // OpenRouter attributes traffic with these. They are not secrets and
          // only affect its own dashboard reporting.
          'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
          'X-Title': 'All In Capital inbound triage',
        },
      },
      model,
      req,
    );
  },

  async embed(): Promise<number[][]> {
    throw new ProviderError(
      'OpenRouter has no embedding endpoint. Set GEMINI_API_KEY to use ' +
        'gemini-embedding-001 for retrieval, or run with MODEL_PROVIDER=offline, ' +
        'which uses deterministic stand-in vectors that are not semantic.',
      undefined,
      false,
    );
  },
};
