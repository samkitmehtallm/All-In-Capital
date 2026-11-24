/**
 * Portkey — the local path (brief §3: "Locally, route through Portkey").
 *
 * Runs the open-source gateway from github.com/Portkey-AI/gateway in front of
 * OpenRouter, so that Case 04's Task 3 ("route every model call through Portkey,
 * with automatic retries switched on") is satisfied without a hosted account.
 *
 *   pnpm gateway     # npx @portkey-ai/gateway, listens on :8787
 *
 * Retries are configured on the gateway via `x-portkey-config`, which means there
 * are now two retry layers: Portkey's and this codebase's own (retry.ts). That is
 * deliberate but worth understanding — Portkey retries the upstream provider
 * transparently, while retry.ts additionally falls back to a second MODEL. Portkey
 * is given the smaller budget so the gateway does not sit silently burning the
 * wall-clock time that retry.ts is trying to bound; Riya is waiting on this output
 * while she works.
 */

import { generateCompatible } from './openai-compatible';
import { ProviderError } from '../retry';
import type { ModelRequest, Provider } from '../types';

/** Portkey retries the upstream twice; retry.ts owns the model fallback. */
const PORTKEY_CONFIG = JSON.stringify({ retry: { attempts: 2, on_status_codes: [429, 500, 502, 503, 504] } });

function apiKey(): string {
  // The gateway forwards this to the upstream provider; it is the OpenRouter key.
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new ProviderError(
      'OPENROUTER_API_KEY is not set. The Portkey gateway forwards it upstream.',
      undefined,
      false,
    );
  }
  return key;
}

export const portkeyProvider: Provider = {
  name: 'portkey',

  async generate(model: string, req: ModelRequest) {
    return generateCompatible(
      {
        name: 'portkey',
        baseUrl: process.env.PORTKEY_BASE_URL ?? 'http://localhost:8787/v1',
        apiKey: apiKey(),
        headers: {
          'x-portkey-provider': process.env.PORTKEY_PROVIDER ?? 'openrouter',
          'x-portkey-config': PORTKEY_CONFIG,
          ...(process.env.PORTKEY_API_KEY ? { 'x-portkey-api-key': process.env.PORTKEY_API_KEY } : {}),
        },
      },
      model,
      req,
    );
  },

  async embed(): Promise<number[][]> {
    // Same gap as OpenRouter: the gateway can only route to what the upstream
    // offers, and the upstream here has no embedding model.
    throw new ProviderError(
      'Portkey is routing to OpenRouter, which has no embedding endpoint. ' +
        'Set GEMINI_API_KEY to use gemini-embedding-001 for retrieval.',
      undefined,
      false,
    );
  },
};
