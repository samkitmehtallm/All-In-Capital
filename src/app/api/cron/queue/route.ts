import { NextResponse } from 'next/server';

import { getStore } from '../../../../lib/db/index';
import { drainQueue, QUEUE } from '../../../../lib/queue/jobs';
import { buildRunners } from '../../../../lib/queue/runners';

/**
 * Drain the queue. Called every five minutes by a scheduled GitHub Action.
 *
 * Serverless cannot keep a worker alive, so the schedule lives outside and this
 * route does one bounded unit of work per call. The budget is set below the
 * platform's function timeout: being cut off mid-step would leave a message
 * invisible until its visibility timeout expires, which delays an application far
 * longer than simply stopping early and picking it up next time.
 *
 * Authenticated with a bearer secret, not with the session: cron has no user. The
 * comparison is length-safe but not constant-time, which is acceptable here because
 * the secret is high-entropy and the route is rate-limited by the platform.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return presented.length === expected.length && presented === expected;
}

async function handle(request: Request) {
  if (!authorised(request)) {
    // No detail. A caller without the secret learns only that it was refused.
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 });
  }

  const store = await getStore();
  const includeResearch = process.env.CRON_INCLUDE_RESEARCH === 'true';

  try {
    const report = await drainQueue(store, buildRunners({ includeResearch }), {
      budgetMs: 45_000,
      maxMessages: 10,
    });

    return NextResponse.json({
      ok: true,
      taken: report.taken,
      completed: report.completed,
      needsALook: report.needsALook,
      failedWillRetry: report.failedWillRetry,
      remaining: await store.queueDepth(QUEUE),
      stoppedBecause: report.stoppedBecause,
      durationMs: report.durationMs,
    });
  } catch (error) {
    // The spend cap reaching its limit is a normal state, not a failure. Returning
    // 500 for it would make the schedule look broken and page whoever is watching.
    const message = error instanceof Error ? error.message : String(error);
    const onHold = /on hold for today/i.test(message);
    return NextResponse.json(
      { ok: onHold, paused: onHold, error: onHold ? undefined : message },
      { status: onHold ? 200 : 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
