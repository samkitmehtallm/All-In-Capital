/**
 * Local worker. The development equivalent of the cron route.
 *
 *   pnpm worker                 # drain once and stop
 *   pnpm worker --watch         # keep polling, like the 5-minute cron
 *   pnpm worker --enqueue-all   # put every application on the queue first
 *   pnpm worker --research      # include the research step
 *
 * Serverless cannot hold a long-running worker open, which is why production uses a
 * scheduled call to /api/cron/queue instead. Both drive the same drainQueue.
 */

import './load-env';

import { getStore } from '../src/lib/db/index';
import { drainQueue, enqueueApplication, QUEUE } from '../src/lib/queue/jobs';
import { buildRunners } from '../src/lib/queue/runners';

const watch = process.argv.includes('--watch');
const enqueueAll = process.argv.includes('--enqueue-all');
const includeResearch = process.argv.includes('--research');
const INTERVAL_MS = 5 * 60 * 1000;

async function drainOnce() {
  const store = await getStore();
  const runners = buildRunners({ includeResearch });

  const depth = await store.queueDepth(QUEUE);
  if (depth === 0) {
    console.log(`  ${new Date().toISOString()}  queue empty`);
    return;
  }

  const report = await drainQueue(store, runners, { budgetMs: 10 * 60 * 1000, maxMessages: 50 });
  console.log(
    `  ${new Date().toISOString()}  took ${report.taken}, done ${report.completed}, ` +
      `needs a look ${report.needsALook}, will retry ${report.failedWillRetry}, ` +
      `stopped: ${report.stoppedBecause}, ${(report.durationMs / 1000).toFixed(1)}s`,
  );

  for (const r of report.results) {
    const state = r.failedAt === null ? 'done' : r.needsALook ? 'NEEDS A LOOK' : 'will retry';
    console.log(
      `    ${r.applicationId.slice(0, 8)}  ${state.padEnd(13)} ran ${r.stepsRun.length}, ` +
        `skipped ${r.stepsSkipped.length}${r.failedAt ? `, failed at ${r.failedAt}` : ''}`,
    );
    if (r.plainReason) console.log(`      ${r.plainReason}`);
  }
}

async function main() {
  const store = await getStore();
  console.log(`\n  store: ${store.kind}  research: ${includeResearch ? 'on' : 'off'}\n`);

  if (enqueueAll) {
    const apps = await store.select<{ id: string; company_name: string }>('applications');
    for (const app of apps) await enqueueApplication(store, String(app.id));
    console.log(`  queued ${apps.length} applications\n`);
  }

  await drainOnce();
  if (!watch) return;

  console.log(`\n  watching, every ${INTERVAL_MS / 60000} minutes. Ctrl-C to stop.\n`);
  setInterval(() => {
    void drainOnce().catch((e) => console.error('  drain failed:', e instanceof Error ? e.message : e));
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
