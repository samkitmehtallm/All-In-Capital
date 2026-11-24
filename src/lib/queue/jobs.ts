/**
 * The queue and its job runner.
 *
 * One message per application, one `jobs` row per step, and the central promise:
 * **never lose an application**. Case 04 puts it as "every one must end up scored,
 * queued, or marked needs attention with a reason. None may disappear."
 *
 * Three mechanisms deliver that, and they matter in this order:
 *
 *  1. **Idempotency.** A job's key is `applicationId:step`. A step already marked
 *     `done` is skipped, so re-delivering a message costs nothing and re-running
 *     the queue after a crash is safe. This is why the message can be acked before
 *     anyone is certain the work was needed.
 *  2. **A visibility timeout, not a lock.** A worker that dies mid-step does not
 *     hold the message: it becomes visible again and another run picks it up. A
 *     lock would need a liveness check that nobody will write.
 *  3. **A terminal state after two attempts.** The brief says two, and two is
 *     right: a third attempt of a deterministic failure produces the same failure
 *     and delays everything behind it. The application lands in "Needs a look"
 *     with a sentence a non-engineer can act on, and the message is acked so the
 *     queue drains.
 *
 * What this deliberately does NOT do is retry forever. An application stuck in a
 * retry loop is indistinguishable from a lost one to the person waiting for it.
 */

import type { Store } from '../db/store';

export const QUEUE = 'applications';

/** Steps in dependency order. `ingest` is done at seed time, hence absent. */
export const STEPS = ['extract', 'reconcile', 'research', 'gates', 'score', 'rank'] as const;
export type Step = (typeof STEPS)[number];

export const MAX_ATTEMPTS_PER_STEP = 2;

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'needs_a_look';

export interface JobRow {
  [key: string]: unknown;
  id: string;
  application_id: string;
  step: string;
  status: JobStatus;
  attempts: number;
  idempotency_key: string;
  error: string | null;
  plain_reason: string | null;
}

export function idempotencyKey(applicationId: string, step: string): string {
  return `${applicationId}:${step}`;
}

/**
 * Turn an error into something Riya can act on.
 *
 * "Needs a look" is read by someone with no engineer to ask, so the reason has to
 * name what to do, not what threw. The raw error is kept in `error` for whoever
 * does have an engineer.
 */
export function plainReasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/GuardError|tried to send|data-not-instructions/i.test(message)) {
    return 'The system stopped itself from sending something it should not have. This needs an engineer, not a retry.';
  }
  if (/on hold for today/i.test(message)) {
    return 'The daily spending limit was reached. This will continue on its own after midnight.';
  }
  if (/\b429\b|rate limit|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'The AI service was busy and stayed busy. Worth trying again in a few minutes.';
  }
  if (/\b5\d\d\b|high demand|UNAVAILABLE/i.test(message)) {
    return 'The AI service was down. Worth trying again later; nothing is lost.';
  }
  if (/OPENROUTER_API_KEY|GEMINI_API_KEY|SUPABASE_SERVICE_KEY|is not set/i.test(message)) {
    return 'A setting is missing, so this could not run. Check the project settings.';
  }
  if (/ENOENT|no such file/i.test(message)) {
    return 'A file this application needs is missing. The documents may need re-uploading.';
  }
  return 'This application could not be read automatically. It needs a human look.';
}

export async function enqueueApplication(store: Store, applicationId: string): Promise<string> {
  return store.enqueue(QUEUE, { applicationId, queuedAt: new Date().toISOString() });
}

async function getJob(store: Store, applicationId: string, step: Step): Promise<JobRow | null> {
  return store.selectOne<JobRow>('jobs', { idempotency_key: idempotencyKey(applicationId, step) });
}

async function upsertJob(
  store: Store,
  applicationId: string,
  step: Step,
  patch: Partial<JobRow>,
): Promise<JobRow> {
  const key = idempotencyKey(applicationId, step);
  const existing = await getJob(store, applicationId, step);
  const [row] = await store.upsert<Record<string, unknown>>(
    'jobs',
    {
      application_id: applicationId,
      step,
      idempotency_key: key,
      status: patch.status ?? existing?.status ?? 'pending',
      attempts: patch.attempts ?? existing?.attempts ?? 0,
      error: patch.error ?? null,
      plain_reason: patch.plain_reason ?? null,
      ...patch,
    },
    ['idempotency_key'],
  );
  return row as unknown as JobRow;
}

export interface StepRunner {
  (applicationId: string): Promise<void>;
}

export interface ProcessResult {
  applicationId: string;
  stepsRun: Step[];
  stepsSkipped: Step[];
  failedAt: Step | null;
  needsALook: boolean;
  plainReason: string | null;
  durationMs: number;
}

/**
 * Run every step for one application, skipping what is already done.
 *
 * Stops at the first failure: the steps are a dependency chain, so scoring an
 * application whose claims were never extracted produces a confident number with
 * nothing behind it, which is worse than no number.
 */
export async function processApplication(
  store: Store,
  applicationId: string,
  runners: Partial<Record<Step, StepRunner>>,
): Promise<ProcessResult> {
  const started = Date.now();
  const stepsRun: Step[] = [];
  const stepsSkipped: Step[] = [];

  for (const step of STEPS) {
    const runner = runners[step];
    if (!runner) continue;

    const existing = await getJob(store, applicationId, step);

    // Idempotency. Also skips a step already in its terminal failure state, so a
    // re-delivered message does not reset an application out of "Needs a look".
    if (existing?.status === 'done') {
      stepsSkipped.push(step);
      continue;
    }
    if (existing?.status === 'needs_a_look') {
      return {
        applicationId,
        stepsRun,
        stepsSkipped,
        failedAt: step,
        needsALook: true,
        plainReason: existing.plain_reason,
        durationMs: Date.now() - started,
      };
    }

    const attempts = (existing?.attempts ?? 0) + 1;
    await upsertJob(store, applicationId, step, {
      status: 'running',
      attempts,
      started_at: new Date().toISOString(),
    });

    try {
      await runner(applicationId);
      await upsertJob(store, applicationId, step, {
        status: 'done',
        attempts,
        error: null,
        plain_reason: null,
        finished_at: new Date().toISOString(),
      });
      stepsRun.push(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = attempts >= MAX_ATTEMPTS_PER_STEP;
      const plain = plainReasonFor(error);

      await upsertJob(store, applicationId, step, {
        status: terminal ? 'needs_a_look' : 'failed',
        attempts,
        error: message.slice(0, 2000),
        plain_reason: terminal ? plain : null,
        finished_at: new Date().toISOString(),
      });

      if (terminal) {
        await store.update(
          'applications',
          { id: applicationId },
          { status: 'needs_a_look', needs_look_reason: plain },
        );
      }

      return {
        applicationId,
        stepsRun,
        stepsSkipped,
        failedAt: step,
        needsALook: terminal,
        plainReason: terminal ? plain : null,
        durationMs: Date.now() - started,
      };
    }
  }

  await store.update('applications', { id: applicationId }, { status: 'scored' });
  return {
    applicationId,
    stepsRun,
    stepsSkipped,
    failedAt: null,
    needsALook: false,
    plainReason: null,
    durationMs: Date.now() - started,
  };
}

export interface DrainOptions {
  /** Stop taking new messages after this long. Serverless has a hard ceiling. */
  budgetMs?: number;
  /** Most messages to take in one drain. */
  maxMessages?: number;
  visibilityMs?: number;
}

export interface DrainReport {
  taken: number;
  completed: number;
  needsALook: number;
  failedWillRetry: number;
  results: ProcessResult[];
  stoppedBecause: 'empty' | 'budget' | 'limit';
  durationMs: number;
}

/**
 * Take messages off the queue and process them until empty, or out of budget.
 *
 * A message is acked in every outcome EXCEPT a non-terminal failure, which is left
 * to become visible again. That is the only path that should retry, and leaving it
 * to the visibility timeout rather than re-queueing keeps the attempt count honest.
 */
export async function drainQueue(
  store: Store,
  runners: Partial<Record<Step, StepRunner>>,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const budgetMs = options.budgetMs ?? 55_000;
  const maxMessages = options.maxMessages ?? 25;
  const started = Date.now();
  const results: ProcessResult[] = [];
  let stoppedBecause: DrainReport['stoppedBecause'] = 'empty';

  while (true) {
    if (Date.now() - started > budgetMs) {
      stoppedBecause = 'budget';
      break;
    }
    if (results.length >= maxMessages) {
      stoppedBecause = 'limit';
      break;
    }

    const message = await store.dequeue(QUEUE, options.visibilityMs ?? 120_000);
    if (!message) break;

    const applicationId = String((message.message as { applicationId?: string }).applicationId ?? '');
    if (!applicationId) {
      // A malformed message is acked rather than left to cycle forever. It is not
      // an application, so nothing is lost by dropping it.
      await store.ack(QUEUE, message.id);
      continue;
    }

    const result = await processApplication(store, applicationId, runners);
    results.push(result);

    const willRetry = result.failedAt !== null && !result.needsALook;
    if (!willRetry) await store.ack(QUEUE, message.id);
  }

  return {
    taken: results.length,
    completed: results.filter((r) => r.failedAt === null).length,
    needsALook: results.filter((r) => r.needsALook).length,
    failedWillRetry: results.filter((r) => r.failedAt !== null && !r.needsALook).length,
    results,
    stoppedBecause,
    durationMs: Date.now() - started,
  };
}
