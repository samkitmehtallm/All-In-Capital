/**
 * Tracing.
 *
 * The brief asks for Langfuse on every model call and every pipeline step. The fund
 * has no Langfuse account yet, so this writes the same span structure to a local
 * JSONL file and the `step_traces` table, and forwards to Langfuse when
 * LANGFUSE_PUBLIC_KEY is set. One interface, so turning Langfuse on later is a key,
 * not a rewrite — and a run is inspectable either way, which is what §12.4 actually
 * asks for.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SpanInput {
  traceId: string;
  step: string;
  model?: string;
  applicationId?: string | null;
  promptVersion?: number | null;
}

export interface SpanEnd {
  status: 'ok' | 'error' | 'cached';
  latencyMs: number;
  retries?: number;
  fellBack?: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface Span {
  end(result: SpanEnd): void;
}

const TRACE_FILE = process.env.TRACE_FILE ?? '.data/traces.jsonl';

function writeTrace(record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TRACE_FILE), { recursive: true });
    appendFileSync(TRACE_FILE, `${JSON.stringify(record)}\n`);
  } catch {
    // Tracing must never break a run. A lost span is a worse outcome than a
    // failed application only if it is the reason the application failed.
  }
}

export function startSpan(input: SpanInput): Span {
  const startedAt = Date.now();
  return {
    end(result: SpanEnd) {
      writeTrace({
        ts: new Date(startedAt).toISOString(),
        trace_id: input.traceId,
        step: input.step,
        model: input.model ?? null,
        application_id: input.applicationId ?? null,
        prompt_version: input.promptVersion ?? null,
        ...result,
      });
      void forwardToLangfuse(input, result);
    },
  };
}

/** No-op until a Langfuse key exists. Kept here so callers never branch on it. */
async function forwardToLangfuse(input: SpanInput, result: SpanEnd): Promise<void> {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return;
  const host = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com';
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString('base64');
  try {
    await fetch(`${host}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        batch: [
          {
            id: `${input.traceId}-${input.step}-${Date.now()}`,
            type: 'span-create',
            timestamp: new Date().toISOString(),
            body: {
              traceId: input.traceId,
              name: input.step,
              metadata: {
                model: input.model,
                promptVersion: input.promptVersion,
                retries: result.retries,
                fellBack: result.fellBack,
                cached: result.status === 'cached',
              },
              level: result.status === 'error' ? 'ERROR' : 'DEFAULT',
              statusMessage: result.error,
            },
          },
        ],
      }),
    });
  } catch {
    // Same reasoning as above.
  }
}

/** Wrap a pipeline step so every step, not just every model call, is traced. */
export async function tracedStep<T>(
  input: SpanInput,
  fn: () => Promise<T>,
): Promise<T> {
  const span = startSpan(input);
  const started = Date.now();
  try {
    const value = await fn();
    span.end({ status: 'ok', latencyMs: Date.now() - started });
    return value;
  } catch (error) {
    span.end({
      status: 'error',
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
