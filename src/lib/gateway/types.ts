/** Shared types for the model gateway. Kept separate so providers do not import index.ts. */

import type { FounderIdentity } from '../redact';

export interface ModelRequest {
  /** Pipeline step name. Appears in traces, llm_calls and the cost report. */
  step: string;
  system: string;
  user: string;
  /** Deterministic calls (<= 0.2) are cached for 30 days. */
  temperature?: number;
  /** JSON schema for structured output. */
  responseSchema?: unknown;
  /** Contacts for this application, so the send-less guard can check against them. */
  founders?: FounderIdentity[];
  /** Retrieved memo passages, so the budget guard can count them. */
  retrievedPassages?: unknown[];
  applicationId?: string | null;
  traceId?: string;
  /** Overrides the env-configured models for this call. */
  models?: { primary: string; fallback?: string };
}

export interface ModelResponse<T = unknown> {
  text: string;
  json: T | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  costUsd: number;
  latencyMs: number;
  retries: number;
  fellBack: boolean;
  cached: boolean;
  traceId: string;
}

export interface Provider {
  name: string;
  generate(
    model: string,
    req: ModelRequest,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  embed(model: string, texts: string[], dim?: number): Promise<number[][]>;
}
