/**
 * Retry policy (brief §12.3): up to 4 attempts on 429 and 5xx, waiting 1s, 2s, 4s
 * plus up to 250 ms of jitter, then the fallback model.
 *
 * Jitter matters more than it looks: the volume test fires 20 applications at once,
 * and without it every one of them retries on the same tick and gets rate-limited
 * together a second time.
 */

export const MAX_ATTEMPTS = 4;
export const BACKOFF_MS = [1000, 2000, 4000];
export const JITTER_MS = 250;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) {
    if (error.retryable) return true;
    if (error.status === 429) return true;
    if (error.status !== undefined && error.status >= 500 && error.status < 600) return true;
    return false;
  }
  // Transport-level failures are worth one more go.
  const code = (error as { code?: string } | null)?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT';
}

export function backoffFor(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return base + Math.floor(random() * JITTER_MS);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AttemptLog {
  attempt: number;
  model: string;
  ok: boolean;
  error?: string;
  waitedMs?: number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: AttemptLog[];
  retries: number;
  fellBack: boolean;
  model: string;
}

/**
 * Run `call` against the primary model, then the fallback.
 *
 * Attempts are shared across both models: four tries in total, not four each, so a
 * hard outage fails in about seven seconds rather than fifteen. Riya is waiting on
 * this output while she works (§operating facts), so a slow failure is a real cost.
 */
export async function withRetries<T>(
  models: { primary: string; fallback?: string },
  call: (model: string) => Promise<T>,
  opts: { random?: () => number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<RetryOutcome<T>> {
  const random = opts.random ?? Math.random;
  const sleepFn = opts.sleepFn ?? sleep;
  const attempts: AttemptLog[] = [];
  const order = [models.primary, models.fallback].filter((m): m is string => Boolean(m));

  let lastError: unknown;
  let attemptNo = 0;

  for (let i = 0; i < order.length; i += 1) {
    const model = order[i];
    const isLastModel = i === order.length - 1;

    while (attemptNo < MAX_ATTEMPTS) {
      try {
        const value = await call(model);
        attempts.push({ attempt: attemptNo + 1, model, ok: true });
        return {
          value,
          attempts,
          retries: attemptNo,
          fellBack: i > 0,
          model,
        };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        attemptNo += 1;
        const retryable = isRetryable(error);
        attempts.push({ attempt: attemptNo, model, ok: false, error: message });

        if (!retryable) break;              // a 400 will not fix itself
        if (attemptNo >= MAX_ATTEMPTS) break;
        if (!isLastModel && attemptNo >= Math.ceil(MAX_ATTEMPTS / 2)) break; // hand over

        const waitedMs = backoffFor(attemptNo - 1, random);
        attempts[attempts.length - 1].waitedMs = waitedMs;
        await sleepFn(waitedMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
