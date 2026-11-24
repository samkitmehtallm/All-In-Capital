/**
 * Shared implementation for OpenAI-compatible chat-completions endpoints.
 *
 * OpenRouter and a self-hosted Portkey gateway speak the same wire format, so they
 * differ only in base URL and headers. Keeping one implementation means the retry
 * classification, the structured-output mapping and the token accounting cannot
 * drift between the local route and the production one — which would make local
 * testing prove nothing about production.
 */

import { ProviderError } from '../retry';
import type { ModelRequest } from '../types';

export interface CompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Extra headers, e.g. Portkey's provider selection and retry config. */
  headers?: Record<string, string>;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
}

/**
 * Map a JSON schema onto the provider's structured-output field.
 *
 * OpenRouter passes `response_format` through to the upstream model. Gemini
 * models accept a json_schema there; a model that does not simply ignores it,
 * which is why the quote-verification and citation checks downstream never trust
 * the schema to have been honoured.
 */
function responseFormat(schema: unknown) {
  if (!schema) return {};
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema },
    },
  };
}

export async function generateCompatible(
  config: CompatibleConfig,
  model: string,
  req: ModelRequest,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let response: Response;

  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...config.headers,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: req.temperature ?? 0.2,
        ...responseFormat(req.responseSchema),
      }),
    });
  } catch (error) {
    // A transport failure is retryable; the policy decides how often.
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    throw new ProviderError(
      `${config.name} request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT',
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      `${config.name} returned ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      response.status === 429,
    );
  }

  const json = (await response.json()) as ChatCompletion;

  // OpenRouter can return HTTP 200 with an error body when an upstream provider
  // fails. Treating that as success yields an empty completion that looks like a
  // model declining to answer, which is a much harder thing to debug later.
  if (json.error) {
    const status = typeof json.error.code === 'number' ? json.error.code : undefined;
    throw new ProviderError(
      `${config.name} upstream error: ${json.error.message ?? 'unknown'}`,
      status,
      status === 429,
    );
  }

  const text = json.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}
