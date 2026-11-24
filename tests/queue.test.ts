/**
 * Queue behaviour under failure.
 *
 * The load test proves the happy path: twenty messages in, ten applications
 * scored, queue empty. It cannot prove the promise that actually matters —
 * "none may disappear" is a claim about what happens when a step throws, and
 * nothing in a successful run exercises that.
 *
 * These use a fake store rather than the local JSON adapter, because the point
 * is to control exactly when a step fails and to look at what was acked. A real
 * store would make the failure incidental and the ack invisible.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Row, Store, Where } from '../src/lib/db/store';
import { matches } from '../src/lib/db/store';
import {
  drainQueue,
  idempotencyKey,
  MAX_ATTEMPTS_PER_STEP,
  plainReasonFor,
  processApplication,
  QUEUE,
  type Step,
} from '../src/lib/queue/jobs';

/** Enough of a Store to run the queue against, and nothing more. */
function fakeStore() {
  const tables = new Map<string, Row[]>();
  const queue: Array<{ id: string; message: Row; invisibleUntil: number }> = [];
  const acked: string[] = [];
  let nextId = 1;

  const rowsOf = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  const store: Store = {
    kind: 'local',
    async insert(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      const written = list.map((r) => ({ ...r, id: r.id ?? String(nextId++) }));
      rowsOf(table).push(...written);
      return written as never;
    },
    async upsert(table, rows, conflict) {
      const list = Array.isArray(rows) ? rows : [rows];
      const out = [];
      for (const row of list) {
        const where = Object.fromEntries(conflict.map((c) => [c, row[c]]));
        const existing = rowsOf(table).find((r) => matches(r, where));
        if (existing) {
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const written = { ...row, id: row.id ?? String(nextId++) };
          rowsOf(table).push(written);
          out.push(written);
        }
      }
      return out as never;
    },
    async update(table, where, patch) {
      const hit = rowsOf(table).filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, patch);
      return hit.length;
    },
    async select(table, where) {
      return rowsOf(table).filter((r) => matches(r, where)) as never;
    },
    async selectOne(table, where) {
      return (rowsOf(table).find((r) => matches(r, where)) ?? null) as never;
    },
    async delete() {
      return 0;
    },
    async count(table, where) {
      return rowsOf(table).filter((r) => matches(r, where)).length;
    },
    async nearest() {
      return [];
    },
    async enqueue(_q, message) {
      const id = String(nextId++);
      queue.push({ id, message, invisibleUntil: 0 });
      return id;
    },
    async dequeue(_q, visibilityMs = 60_000) {
      const now = Date.now();
      const next = queue.find((m) => m.invisibleUntil <= now);
      if (!next) return null;
      next.invisibleUntil = now + visibilityMs;
      return { id: next.id, message: next.message };
    },
    async ack(_q, id) {
      acked.push(id);
      const i = queue.findIndex((m) => m.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    async queueDepth() {
      const now = Date.now();
      return queue.filter((m) => m.invisibleUntil <= now).length;
    },
  };

  return {
    store,
    tables,
    queue,
    acked,
    jobs: () => rowsOf('jobs'),
    apps: () => rowsOf('applications'),
    /** What the visibility timeout does on its own, without waiting for it. */
    expireVisibility: () => queue.forEach((m) => (m.invisibleUntil = 0)),
  };
}

function jobFor(f: ReturnType<typeof fakeStore>, appId: string, step: Step) {
  return f.jobs().find((j) => j.idempotency_key === idempotencyKey(appId, step));
}

describe('processApplication', () => {
  it('runs every step it is given and marks the application scored', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    const ran: string[] = [];

    const result = await processApplication(f.store, 'a1', {
      extract: async () => void ran.push('extract'),
      score: async () => void ran.push('score'),
    });

    assert.deepEqual(ran, ['extract', 'score']);
    assert.deepEqual(result.stepsRun, ['extract', 'score']);
    assert.equal(result.failedAt, null);
    assert.equal(f.apps()[0].status, 'scored');
  });

  it('skips a step already done, and does not re-run it', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    let runs = 0;
    const runners = { extract: async () => void (runs += 1) };

    await processApplication(f.store, 'a1', runners);
    const second = await processApplication(f.store, 'a1', runners);

    assert.equal(runs, 1, 'the second delivery must do no work');
    assert.deepEqual(second.stepsSkipped, ['extract']);
    assert.deepEqual(second.stepsRun, []);
  });

  it('stops at the first failure rather than scoring on nothing', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    let scored = false;

    const result = await processApplication(f.store, 'a1', {
      extract: async () => {
        throw new Error('pdf unreadable');
      },
      score: async () => void (scored = true),
    });

    assert.equal(scored, false, 'scoring an application with no claims is worse than no score');
    assert.equal(result.failedAt, 'extract');
    assert.notEqual(f.apps()[0].status, 'scored');
  });

  it('retries once, then goes terminal with a reason a non-engineer can act on', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    const runners = {
      extract: async () => {
        throw new Error('ENOENT: no such file');
      },
    };

    const first = await processApplication(f.store, 'a1', runners);
    assert.equal(first.needsALook, false, 'the first failure is worth another go');
    assert.equal(jobFor(f, 'a1', 'extract')?.status, 'failed');

    const second = await processApplication(f.store, 'a1', runners);
    assert.equal(second.needsALook, true);
    assert.equal(jobFor(f, 'a1', 'extract')?.attempts, MAX_ATTEMPTS_PER_STEP);
    assert.equal(jobFor(f, 'a1', 'extract')?.status, 'needs_a_look');
    assert.equal(f.apps()[0].status, 'needs_a_look');
    assert.match(String(f.apps()[0].needs_look_reason), /documents may need re-uploading/);
  });

  it('keeps the raw error alongside the plain reason', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    const runners = {
      extract: async () => {
        throw new Error('TypeError: cannot read properties of undefined');
      },
    };
    await processApplication(f.store, 'a1', runners);
    await processApplication(f.store, 'a1', runners);

    const job = jobFor(f, 'a1', 'extract')!;
    assert.match(String(job.error), /cannot read properties of undefined/);
    assert.doesNotMatch(String(job.plain_reason), /TypeError/);
  });

  it('does not lift an application back out of "needs a look"', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    let attempts = 0;
    const runners = {
      extract: async () => {
        attempts += 1;
        throw new Error('ENOENT: no such file');
      },
    };

    await processApplication(f.store, 'a1', runners);
    await processApplication(f.store, 'a1', runners);
    assert.equal(attempts, 2);

    // A third delivery, long after. The step must not run again and the
    // application must stay where someone was told to look at it.
    const third = await processApplication(f.store, 'a1', runners);
    assert.equal(attempts, 2, 'a terminal step must not be retried by re-delivery');
    assert.equal(third.needsALook, true);
    assert.equal(f.apps()[0].status, 'needs_a_look');
  });
});

describe('drainQueue', () => {
  it('acks a terminal failure so the queue drains, and leaves a reason behind', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    const runners = {
      extract: async () => {
        throw new Error('ENOENT: no such file');
      },
    };

    // Two deliveries: the first fails and stays on the queue, and the second —
    // which only happens because the visibility timeout expired, not because
    // anything re-queued it — goes terminal and is acked.
    await f.store.enqueue(QUEUE, { applicationId: 'a1' });
    await drainQueue(f.store, runners);
    assert.equal(f.queue.length, 1, 'the first failure stays on the queue');

    f.expireVisibility();
    const report = await drainQueue(f.store, runners);
    assert.equal(report.needsALook, 1);
    assert.equal(await f.store.queueDepth(QUEUE), 0, 'a terminal failure must not sit on the queue');
    assert.equal(f.apps()[0].status, 'needs_a_look');
    assert.ok(f.apps()[0].needs_look_reason, 'needs a look without a reason is a lost application');
  });

  it('leaves a first failure on the queue to become visible again', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    await f.store.enqueue(QUEUE, { applicationId: 'a1' });

    const report = await drainQueue(
      f.store,
      {
        extract: async () => {
          throw new Error('ENOENT: no such file');
        },
      },
    );

    assert.equal(report.failedWillRetry, 1);
    assert.deepEqual(f.acked, [], 'acking a retryable failure would lose the application');
    assert.equal(f.queue.length, 1);
  });

  it('acks a malformed message instead of cycling on it forever', async () => {
    const f = fakeStore();
    await f.store.enqueue(QUEUE, { nothing: 'useful' });

    const report = await drainQueue(f.store, { extract: async () => {} });

    assert.equal(report.taken, 0, 'it was never an application');
    assert.equal(f.queue.length, 0);
    assert.equal(f.acked.length, 1);
  });

  it('stops at the message limit and reports why, leaving the rest queued', async () => {
    const f = fakeStore();
    for (const id of ['a1', 'a2', 'a3']) {
      await f.store.insert('applications', { id, status: 'new' });
      await f.store.enqueue(QUEUE, { applicationId: id });
    }

    const report = await drainQueue(f.store, { extract: async () => {} }, { maxMessages: 2 });

    assert.equal(report.taken, 2);
    assert.equal(report.stoppedBecause, 'limit');
    assert.equal(await f.store.queueDepth(QUEUE), 1, 'the remainder waits, it is not dropped');
  });

  it('counts a duplicate delivery as completed, not as work', async () => {
    const f = fakeStore();
    await f.store.insert('applications', { id: 'a1', status: 'new' });
    await f.store.enqueue(QUEUE, { applicationId: 'a1' });
    await f.store.enqueue(QUEUE, { applicationId: 'a1' });

    let runs = 0;
    const report = await drainQueue(f.store, { extract: async () => void (runs += 1) });

    assert.equal(report.taken, 2);
    assert.equal(report.completed, 2);
    assert.equal(runs, 1, 'the duplicate must cost nothing');
    assert.equal(await f.store.queueDepth(QUEUE), 0);
  });
});

describe('plainReasonFor', () => {
  it('tells the reader a guard failure is not worth retrying', () => {
    const reason = plainReasonFor(new Error('GuardError: tried to send an email address'));
    assert.match(reason, /not a retry/);
    assert.doesNotMatch(reason, /GuardError/);
  });

  it('tells the reader the spend cap clears on its own', () => {
    assert.match(plainReasonFor(new Error('on hold for today')), /after midnight/);
  });

  it('distinguishes busy from down, because the advice differs', () => {
    assert.match(plainReasonFor(new Error('429 rate limit')), /few minutes/);
    assert.match(plainReasonFor(new Error('503 UNAVAILABLE')), /later/);
  });

  it('never leaks a stack trace or a variable name into the reason', () => {
    const reason = plainReasonFor(new Error("Cannot read properties of undefined (reading 'claims')"));
    assert.doesNotMatch(reason, /undefined|properties|claims/);
    assert.match(reason, /human look/);
  });
});
