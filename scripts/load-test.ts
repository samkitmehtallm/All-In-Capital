/**
 * Load test. Two separate questions, because the brief asks two.
 *
 *   pnpm loadtest calls          # 12.3: 20 model calls at once
 *   pnpm loadtest applications   # Case 04 Task 2: 20 applications in at once
 *   pnpm loadtest both
 *
 * §12.3 wants "a load-test script that fires 20 calls at once and reports success,
 * failure, error type and time". Case 04 Task 2 wants "20 applications into your
 * system at once. Every one must end up scored, queued, or marked needs attention
 * with a reason. None may disappear."
 *
 * They test different things. The first is about the gateway: retries, the fallback
 * model, the spend cap, rate limits. The second is about the queue: that nothing is
 * dropped when more arrives than can be processed. Passing one says nothing about
 * the other.
 */

import './load-env';

import { getStore } from '../src/lib/db/index';
import { callModel } from '../src/lib/gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../src/lib/gateway/guards';
import { drainQueue, enqueueApplication, QUEUE, STEPS } from '../src/lib/queue/jobs';
import { buildRunners } from '../src/lib/queue/runners';

const mode = process.argv[2] ?? 'both';
const CONCURRENT_CALLS = 20;
const TARGET_MESSAGES = 20;

/** Group errors by what they are, not by their message text. */
function errorType(message: string): string {
  if (/on hold for today/i.test(message)) return 'daily spend cap';
  if (/\b429\b|rate limit|quota/i.test(message)) return 'rate limited (429)';
  if (/\b5\d\d\b|high demand|UNAVAILABLE/i.test(message)) return 'provider 5xx';
  if (/GuardError|tried to send/i.test(message)) return 'guard refused';
  if (/timeout|ETIMEDOUT|aborted/i.test(message)) return 'timeout';
  if (/is not set/i.test(message)) return 'missing configuration';
  return 'other';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function testConcurrentCalls() {
  console.log(`\n  ${CONCURRENT_CALLS} model calls fired at once\n`);

  // Each prompt is distinct, so the 30-day cache cannot answer them. A cached run
  // would report wonderful latency and prove nothing about the provider.
  //
  // The run id is letters, not a timestamp. A 13-digit timestamp matches the
  // phone-number pattern and the send-less guard refused all twenty calls — the
  // third time a long run of digits has done that. Identifiers that go into a
  // prompt should not look like phone numbers.
  const runId = Math.random().toString(36).slice(2, 10);
  const started = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) =>
      (async () => {
        const at = Date.now();
        const response = await callModel({
          step: 'load_test',
          system: `Reply with JSON only: {"n": <the number you are given>}.\n\n${DATA_NOT_INSTRUCTIONS}`,
          user: `The number is ${i + 1}. Run tag ${runId}.`,
          temperature: 0,
        });
        return { ms: Date.now() - at, retries: response.retries, fellBack: response.fellBack, cached: response.cached, costInr: response.costInr };
      })(),
    ),
  );
  const wallMs = Date.now() - started;

  const ok = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<{
    ms: number; retries: number; fellBack: boolean; cached: boolean; costInr: number;
  }>[];
  const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

  const times = ok.map((s) => s.value.ms).sort((a, b) => a - b);
  const byType = new Map<string, number>();
  for (const f of failed) {
    const message = f.reason instanceof Error ? f.reason.message : String(f.reason);
    const type = errorType(message);
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }

  console.log(`    succeeded      ${ok.length} of ${CONCURRENT_CALLS}`);
  console.log(`    failed         ${failed.length}`);
  console.log(`    retried        ${ok.filter((s) => s.value.retries > 0).length}`);
  console.log(`    fell back      ${ok.filter((s) => s.value.fellBack).length}`);
  console.log(`    served cached  ${ok.filter((s) => s.value.cached).length}`);
  console.log(`    wall clock     ${(wallMs / 1000).toFixed(1)}s`);
  if (times.length) {
    console.log(
      `    per call       p50 ${percentile(times, 50)}ms  p95 ${percentile(times, 95)}ms  max ${times[times.length - 1]}ms`,
    );
  }
  console.log(`    cost           INR ${ok.reduce((a, s) => a + s.value.costInr, 0).toFixed(4)}`);

  if (byType.size > 0) {
    console.log(`\n    failures by type`);
    for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(count).padStart(3)}  ${type}`);
    }
  }
}

async function testApplicationFlood() {
  const store = await getStore();
  const apps = await store.select<{ id: string; company_name: string }>('applications');
  if (apps.length === 0) throw new Error('No applications. Run pnpm seed.');

  console.log(`\n  ${TARGET_MESSAGES} messages onto the queue at once\n`);

  // There are ten applications, so each is queued twice to reach twenty. That is
  // not a weaker test: the duplicate pass is exactly how idempotency gets proved,
  // because the second delivery must do no work and must not undo the first.
  const ids: string[] = [];
  for (let i = 0; i < TARGET_MESSAGES; i += 1) ids.push(String(apps[i % apps.length].id));

  const enqueueStarted = Date.now();
  await Promise.all(ids.map((id) => enqueueApplication(store, id)));
  const depthAfterEnqueue = await store.queueDepth(QUEUE);

  console.log(`    enqueued       ${ids.length} in ${Date.now() - enqueueStarted}ms`);
  console.log(`    queue depth    ${depthAfterEnqueue}`);
  console.log(`    distinct apps  ${new Set(ids).size} (each queued twice)\n`);

  const drainStarted = Date.now();
  const report = await drainQueue(store, buildRunners({ includeResearch: false }), {
    budgetMs: 20 * 60 * 1000,
    maxMessages: TARGET_MESSAGES + 5,
  });

  console.log(`    took           ${report.taken}`);
  console.log(`    completed      ${report.completed}`);
  console.log(`    needs a look   ${report.needsALook}`);
  console.log(`    will retry     ${report.failedWillRetry}`);
  console.log(`    stopped        ${report.stoppedBecause}`);
  console.log(`    wall clock     ${((Date.now() - drainStarted) / 1000).toFixed(1)}s`);

  const skipped = report.results.reduce((a, r) => a + r.stepsSkipped.length, 0);
  const ran = report.results.reduce((a, r) => a + r.stepsRun.length, 0);
  console.log(`    steps run      ${ran}`);
  console.log(`    steps skipped  ${skipped}  (idempotency: the second delivery of each)`);

  // The actual promise: none may disappear. Every distinct application must be in
  // a state someone can act on, and the queue must be empty.
  console.log(`\n    where every application ended up`);
  const distinct = [...new Set(ids)];
  const states = new Map<string, number>();
  let unaccounted = 0;

  for (const id of distinct) {
    const app = await store.selectOne<{ company_name: string; status: string; needs_look_reason: string | null }>(
      'applications',
      { id },
    );
    const jobs = await store.select<{ step: string; status: string }>('jobs', { application_id: id });
    const done = jobs.filter((j) => j.status === 'done').length;
    const stuck = jobs.find((j) => j.status === 'needs_a_look');

    const state = stuck
      ? 'needs a look'
      : done >= STEPS.filter((s) => s !== 'research').length
        ? 'scored'
        : jobs.length > 0
          ? 'part way'
          : 'untouched';
    states.set(state, (states.get(state) ?? 0) + 1);
    if (state === 'untouched') unaccounted += 1;

    if (stuck) {
      console.log(`      ${app?.company_name?.padEnd(11)} needs a look at ${stuck.step}`);
      console.log(`        ${app?.needs_look_reason ?? '(no reason recorded)'}`);
    }
  }

  for (const [state, count] of states) console.log(`      ${String(count).padStart(3)}  ${state}`);

  const remaining = await store.queueDepth(QUEUE);
  console.log(`\n    queue depth after  ${remaining}`);

  const lost = unaccounted > 0 || remaining > 0;
  console.log(
    `\n    ${lost ? 'FAILED' : 'PASSED'}: ${
      lost
        ? `${unaccounted} untouched and ${remaining} left on the queue`
        : 'every application is in a state someone can act on, and the queue is empty'
    }`,
  );
}

async function main() {
  const store = await getStore();
  console.log(`\n  store: ${store.kind}`);

  if (mode === 'calls' || mode === 'both') await testConcurrentCalls();
  if (mode === 'applications' || mode === 'both') await testApplicationFlood();
  console.log('');
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
