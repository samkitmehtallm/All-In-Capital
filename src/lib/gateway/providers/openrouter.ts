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

  /**
   * Web search, via OpenRouter's `web` plugin.
   *
   * Chosen over Gemini's Google Search grounding after testing both: grounding on
   * the free Gemini tier returned 429 (quota) and then 503 (high demand) on every
   * attempt, and gemini-2.5-flash is no longer served to new accounts on the direct
   * API at all. The same model through OpenRouter works, so search goes the same
   * way as every other model call and draws on the same budget.
   *
   * The model's prose is discarded. Only `annotations[].url_citation` is kept: the
   * research step fetches each page itself and takes a verbatim quote from it,
   * because a search summary is a claim ABOUT a page, not a quotation FROM one.
   */
  async searchGrounded(model: string, query: string) {
    const maxResults = Number(process.env.SEARCH_MAX_RESULTS ?? 5);
    let response: Response;

    try {
      response = await fetch(
        `${process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey()}`,
            'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
            'X-Title': 'All In Capital inbound triage',
          },
          body: JSON.stringify({
            model,
            plugins: [{ id: 'web', max_results: maxResults }],
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: `${query}\n\nList the sources you consulted. Do not speculate.`,
              },
            ],
          }),
        },
      );
    } catch (error) {
      throw new ProviderError(
        `openrouter search failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `openrouter search returned ${response.status}: ${body.slice(0, 200)}`,
        response.status,
        response.status === 429,
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          annotations?: Array<{ url_citation?: { url?: string; title?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: number };
    };

    if (json.error) {
      throw new ProviderError(
        `openrouter search upstream error: ${json.error.message ?? 'unknown'}`,
        typeof json.error.code === 'number' ? json.error.code : undefined,
        false,
      );
    }

    const annotations = json.choices?.[0]?.message?.annotations ?? [];
    const seen = new Set<string>();
    const sources = annotations
      .map((a) => ({ url: a.url_citation?.url ?? '', title: a.url_citation?.title ?? '' }))
      .filter((s) => {
        if (!s.url || seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });

    return {
      sources,
      text: json.choices?.[0]?.message?.content ?? '',
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
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
