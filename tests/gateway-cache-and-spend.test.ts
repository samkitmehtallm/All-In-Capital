import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LocalStore } from '../src/lib/db/local';
import { setStore } from '../src/lib/db/index';
import { callModel, cacheKey, SpendCapReached } from '../src/lib/gateway/index';
import { computeCost, istDay, msUntilNextIstMidnight, RATES } from '../src/lib/gateway/cost';
import { DATA_NOT_INSTRUCTIONS } from '../src/lib/gateway/guards';
import { registerOfflineHandler } from '../src/lib/gateway/providers/offline';

const SYSTEM = `Return the number of paying customers as JSON.\n\n${DATA_NOT_INSTRUCTIONS}`;

let dir: string;
let store: LocalStore;
let calls = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aic-test-'));
  store = new LocalStore(dir);
  setStore(store);
  calls = 0;
  process.env.MODEL_PROVIDER = 'offline';
  process.env.TRACE_FILE = join(dir, 'traces.jsonl');
  delete process.env.DAILY_SPEND_CAP_INR;

  registerOfflineHandler('test_step', () => {
    calls += 1;
    return JSON.stringify({ customers: 24, call: calls });
  });
});

afterEach(() => {
  setStore(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('cache', () => {
  it('serves a repeat deterministic call from cache, at zero cost', async () => {
    const req = { step: 'test_step', system: SYSTEM, user: 'CAPilot deck page 4', temperature: 0 };

    const first = await callModel(req);
    assert.equal(first.cached, false);
    assert.equal(calls, 1);

    const second = await callModel(req);
    assert.equal(second.cached, true);
    assert.equal(second.costInr, 0);
    // The provider was not asked a second time.
    assert.equal(calls, 1);
    assert.equal(second.text, first.text);
  });

  it('logs the cached call, so it still appears in the ledger at zero cost', async () => {
    const req = { step: 'test_step', system: SYSTEM, user: 'Talkbook deck page 5', temperature: 0 };
    await callModel(req);
    await callModel(req);

    const logged = await store.select<{ cached: boolean; cost_inr: number }>('llm_calls');
    assert.equal(logged.length, 2);
    const cachedRows = logged.filter((r) => r.cached);
    assert.equal(cachedRows.length, 1);
    assert.equal(Number(cachedRows[0].cost_inr), 0);
  });

  it('counts hits on the cache entry', async () => {
    const req = { step: 'test_step', system: SYSTEM, user: 'GrainKind deck page 6', temperature: 0 };
    await callModel(req);
    await callModel(req);
    await callModel(req);

    const entry = await store.selectOne<{ hits: number }>('llm_cache', {
      cache_key: cacheKey('offline', SYSTEM, 'GrainKind deck page 6'),
    });
    assert.equal(Number(entry?.hits), 2);
  });

  it('does not cache a warm call', async () => {
    // Redo chips ask for a different opening; serving the previous one from cache
    // would make "try again" do nothing.
    const req = { step: 'test_step', system: SYSTEM, user: 'redo warmer', temperature: 0.7 };
    await callModel(req);
    await callModel(req);
    assert.equal(calls, 2);
    assert.equal(await store.count('llm_cache'), 0);
  });

  it('treats an expired entry as a miss and removes it', async () => {
    const user = 'Pumpwise deck page 5';
    const key = cacheKey('offline', SYSTEM, user);
    await store.insert('llm_cache', {
      cache_key: key,
      model: 'offline',
      response: { text: '{"stale":true}', inputTokens: 1, outputTokens: 1 },
      hits: 0,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await callModel({ step: 'test_step', system: SYSTEM, user, temperature: 0 });
    assert.equal(res.cached, false);
    assert.doesNotMatch(res.text, /stale/);
    assert.equal(calls, 1);
  });

  it('keys on the model, system and user together', () => {
    const a = cacheKey('gemini-2.5-flash', 'sys', 'user');
    assert.notEqual(a, cacheKey('gemini-2.5-pro', 'sys', 'user'));
    assert.notEqual(a, cacheKey('gemini-2.5-flash', 'sys2', 'user'));
    assert.notEqual(a, cacheKey('gemini-2.5-flash', 'sys', 'user2'));
    assert.equal(a, cacheKey('gemini-2.5-flash', 'sys', 'user'));
  });
});

describe('daily spend cap', () => {
  it('pauses once the day is over cap, with a message that names no amount', async () => {
    process.env.DAILY_SPEND_CAP_INR = '10';
    await store.insert('spend_days', { day_ist: istDay(), spend_inr: 10.5, cap_inr: 10 });

    await assert.rejects(
      callModel({ step: 'test_step', system: SYSTEM, user: 'anything', temperature: 0 }),
      (e: unknown) => {
        assert.ok(e instanceof SpendCapReached);
        assert.equal(
          e.message,
          'New applications are on hold for today and will continue after midnight',
        );
        // The founder does not want cost on a screen, so no figure may leak through
        // an error message that the UI will render.
        assert.doesNotMatch(e.message, /[0-9]/);
        return true;
      },
    );
  });

  it('records that it paused', async () => {
    process.env.DAILY_SPEND_CAP_INR = '10';
    await store.insert('spend_days', { day_ist: istDay(), spend_inr: 99, cap_inr: 10 });
    await assert.rejects(callModel({ step: 'test_step', system: SYSTEM, user: 'x', temperature: 0 }));

    const row = await store.selectOne<{ paused_at: string }>('spend_days', { day_ist: istDay() });
    assert.ok(row?.paused_at, 'expected paused_at to be set');
  });

  it('resumes on its own once the IST day rolls over', async () => {
    process.env.DAILY_SPEND_CAP_INR = '10';
    // Yesterday was over cap. Today has no row at all, which is the whole mechanism:
    // the reset is the day key changing, not a job someone has to remember to run.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    await store.insert('spend_days', {
      day_ist: istDay(yesterday),
      spend_inr: 999,
      cap_inr: 10,
      paused_at: yesterday.toISOString(),
    });

    const res = await callModel({ step: 'test_step', system: SYSTEM, user: 'today', temperature: 0 });
    assert.equal(res.cached, false);
  });

  it('computes the IST day boundary rather than the host local day', () => {
    // 19:00 UTC on the 23rd is already the 24th in Delhi.
    assert.equal(istDay(new Date('2026-11-23T19:00:00Z')), '2026-11-24');
    assert.equal(istDay(new Date('2026-11-23T18:29:00Z')), '2026-11-23');
    const ms = msUntilNextIstMidnight(new Date('2026-11-23T18:30:00Z'));
    assert.equal(ms, 24 * 3600 * 1000);
  });
});

describe('cost', () => {
  it('charges a known model at its published rate', () => {
    const cost = computeCost('gemini-2.5-flash', 1_000_000, 1_000_000);
    assert.equal(cost.usd, RATES['gemini-2.5-flash'].inputPerM + RATES['gemini-2.5-flash'].outputPerM);
    assert.equal(cost.rateAssumed, false);
  });

  it('charges an unknown model at the worst known rate rather than zero', () => {
    // A cost report that silently under-reports is worse than one that over-reports,
    // because the payback sums in the fine-tuning brief are built on it.
    const cost = computeCost('some-new-model', 1_000_000, 0);
    assert.ok(cost.usd > 0);
    assert.equal(cost.rateAssumed, true);
  });

  it('charges the offline provider nothing', () => {
    assert.equal(computeCost('offline', 10_000, 10_000).usd, 0);
  });
});
