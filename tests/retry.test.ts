import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  backoffFor,
  BACKOFF_MS,
  isRetryable,
  JITTER_MS,
  MAX_ATTEMPTS,
  ProviderError,
  withRetries,
} from '../src/lib/gateway/retry';

describe('isRetryable', () => {
  it('retries rate limits and server faults', () => {
    assert.equal(isRetryable(new ProviderError('rate limited', 429)), true);
    assert.equal(isRetryable(new ProviderError('bad gateway', 502)), true);
    assert.equal(isRetryable(new ProviderError('unavailable', 503)), true);
  });

  it('does not retry a request the caller got wrong', () => {
    // A 400 retried four times is four times the latency and the same answer.
    assert.equal(isRetryable(new ProviderError('bad request', 400)), false);
    assert.equal(isRetryable(new ProviderError('unauthorised', 401)), false);
    assert.equal(isRetryable(new ProviderError('not found', 404)), false);
  });

  it('retries transport failures', () => {
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable(new Error('something else')), false);
  });
});

describe('backoffFor', () => {
  it('follows 1s, 2s, 4s', () => {
    assert.equal(backoffFor(0, () => 0), BACKOFF_MS[0]);
    assert.equal(backoffFor(1, () => 0), BACKOFF_MS[1]);
    assert.equal(backoffFor(2, () => 0), BACKOFF_MS[2]);
  });

  it('holds the last step rather than growing without bound', () => {
    assert.equal(backoffFor(9, () => 0), BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it('adds up to 250ms of jitter', () => {
    // Without jitter the volume test's twenty applications retry on the same tick
    // and get rate-limited together a second time.
    assert.equal(backoffFor(0, () => 0.999), BACKOFF_MS[0] + 249);
    const spread = backoffFor(0, () => 0.5) - backoffFor(0, () => 0);
    assert.ok(spread > 0 && spread < JITTER_MS);
  });
});

describe('withRetries', () => {
  const noSleep = async () => {};

  it('returns on the first success without retrying', async () => {
    let calls = 0;
    const out = await withRetries({ primary: 'a', fallback: 'b' }, async () => {
      calls += 1;
      return 'ok';
    }, { sleepFn: noSleep });

    assert.equal(out.value, 'ok');
    assert.equal(calls, 1);
    assert.equal(out.retries, 0);
    assert.equal(out.fellBack, false);
    assert.equal(out.model, 'a');
  });

  it('retries a 429 then succeeds on the primary', async () => {
    let calls = 0;
    const out = await withRetries({ primary: 'a', fallback: 'b' }, async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError('rate limited', 429);
      return 'ok';
    }, { sleepFn: noSleep, random: () => 0 });

    assert.equal(out.value, 'ok');
    assert.equal(out.model, 'a');
    assert.equal(out.retries, 1);
    assert.equal(out.fellBack, false);
  });

  it('falls back to the second model when the primary keeps failing', async () => {
    const seen: string[] = [];
    const out = await withRetries({ primary: 'a', fallback: 'b' }, async (model) => {
      seen.push(model);
      if (model === 'a') throw new ProviderError('unavailable', 503);
      return 'ok';
    }, { sleepFn: noSleep, random: () => 0 });

    assert.equal(out.value, 'ok');
    assert.equal(out.model, 'b');
    assert.equal(out.fellBack, true);
    assert.ok(seen.includes('a') && seen.includes('b'));
  });

  it('spends at most MAX_ATTEMPTS across both models, not per model', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries({ primary: 'a', fallback: 'b' }, async () => {
        calls += 1;
        throw new ProviderError('unavailable', 503);
      }, { sleepFn: noSleep, random: () => 0 }),
    );
    // Riya is waiting on this output while she works, so a hard outage has to fail
    // in seconds rather than exhausting four attempts on each model in turn.
    assert.ok(calls <= MAX_ATTEMPTS, `made ${calls} calls, budget is ${MAX_ATTEMPTS}`);
  });

  it('gives up immediately on an error that will not fix itself', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries({ primary: 'a' }, async () => {
        calls += 1;
        throw new ProviderError('bad request', 400);
      }, { sleepFn: noSleep }),
      /bad request/,
    );
    assert.equal(calls, 1);
  });

  it('records what happened on each attempt', async () => {
    let calls = 0;
    const out = await withRetries({ primary: 'a' }, async () => {
      calls += 1;
      if (calls < 2) throw new ProviderError('rate limited', 429);
      return 'ok';
    }, { sleepFn: noSleep, random: () => 0 });

    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].ok, false);
    assert.equal(out.attempts[0].waitedMs, BACKOFF_MS[0]);
    assert.equal(out.attempts[1].ok, true);
  });
});
