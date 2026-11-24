import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LocalStore } from '../src/lib/db/local';
import {
  evaluateG3,
  STRONG_Z,
  strongBandReachable,
  WEAK_Z,
} from '../src/lib/gates/g3-portfolio-conflict';

/**
 * Fixture vectors rather than real embeddings: this gate's job is the z-score
 * decision over vectors, and a test that needed an API key would stop being run.
 * The real-data behaviour it encodes is recorded in the module header.
 */
const DIM = 24;

/** A unit vector pointing mostly along `axis`, with `noise` spread elsewhere. */
function vec(axis: number, noise = 0): number[] {
  const v = new Array<number>(DIM).fill(noise);
  v[axis] = 1;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / norm);
}

let dir: string;
let store: LocalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aic-g3-'));
  store = new LocalStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seedPortfolio(rows: Array<{ name: string; one_liner: string | null; embedding: number[] }>) {
  for (const r of rows) await store.insert('portfolio_companies', { ...r, source_url: 'x', source_note: 'y' });
}

describe('G3 portfolio conflict', () => {
  it('flags the company that stands clear of the rest', async () => {
    // Twenty-two rows, matching the real portfolio. Size matters: the largest
    // reachable z is sqrt(N - 1), so a five-row fixture caps at exactly 2.0 and
    // could never reach STRONG_Z however obvious the overlap.
    await seedPortfolio([
      { name: 'MeetRecord', one_liner: 'Sales call summaries and CRM updates.', embedding: vec(0) },
      ...Array.from({ length: 21 }, (_, i) => ({
        name: `Other ${i}`,
        one_liner: `Something unrelated ${i}.`,
        embedding: vec(i + 1),
      })),
    ]);

    const result = await evaluateG3(store, vec(0));
    assert.equal(result.gateKey, 'g3_conflict');
    assert.equal(result.tripped, true);
    assert.equal(result.matches[0].name, 'MeetRecord');
    assert.ok(result.matches[0].z >= STRONG_Z, `z was ${result.matches[0].z}`);
    assert.match(result.plainName, /^Overlaps MeetRecord$/);
    // Plain words, no codes, no similarity number on screen.
    assert.doesNotMatch(result.plainName, /0\.|z=|cosine/);
  });

  it('does not call a flat field an overlap, however high the raw similarity', async () => {
    // Every row is almost equally similar. This is the Settlr case: 0.630 against
    // a next-best 0.620 is noise, and an absolute threshold would flag it.
    await seedPortfolio([
      { name: 'NewMe', one_liner: 'Fast fashion.', embedding: vec(0, 0.97) },
      { name: 'Wint Wealth', one_liner: 'Retail bonds.', embedding: vec(1, 0.97) },
      { name: 'Giva', one_liner: 'Jewellery.', embedding: vec(2, 0.97) },
      { name: 'Taakat', one_liner: 'FMCG.', embedding: vec(3, 0.97) },
    ]);

    const result = await evaluateG3(store, vec(0, 0.97));
    // The raw similarity is very high...
    assert.ok(result.matches[0].similarity > 0.9, `similarity ${result.matches[0].similarity}`);
    // ...but it is not described as an overlap, because nothing separates it.
    assert.doesNotMatch(result.plainName, /^Overlaps/);
  });

  it('still reports a weak match rather than staying silent', async () => {
    // "A false alarm beats a missed conflict" (Meeting 4): below STRONG_Z the gate
    // reports, it does not suppress.
    await seedPortfolio([
      { name: 'Hotelzify', one_liner: 'Hotel booking sites.', embedding: vec(0, 0.55) },
      { name: 'Giva', one_liner: 'Jewellery.', embedding: vec(1, 0.9) },
      { name: 'SuperK', one_liner: 'Retail.', embedding: vec(2, 0.9) },
      { name: 'Volt', one_liner: 'Something.', embedding: vec(3, 0.9) },
    ]);

    const result = await evaluateG3(store, vec(0, 0.55));
    assert.ok(result.matches.length > 0, 'expected a reported match');
    assert.ok(result.matches[0].z >= WEAK_Z);
    assert.match(result.reason, /worth a glance|much the same thing/);
  });

  it('counts the rows it can only match on a name', async () => {
    // Six of the real twenty-two have no description. Reporting full coverage
    // while matching those on a single word would overstate what G3 can promise.
    await seedPortfolio([
      { name: 'MeetRecord', one_liner: 'Sales calls.', embedding: vec(0) },
      { name: 'Magma', one_liner: null, embedding: vec(1) },
      { name: 'Volt', one_liner: null, embedding: vec(2) },
    ]);

    const result = await evaluateG3(store, vec(0));
    assert.equal(result.unmatchableCount, 2);
  });

  it('knows when the strong band is unreachable for the portfolio size', () => {
    // A five-company portfolio caps every match at z 2.0, so no overlap could
    // ever be called strong. That must be visible, not look like "none found".
    assert.equal(strongBandReachable(5), false);
    assert.equal(strongBandReachable(22), true);
    assert.equal(strongBandReachable(0), false);
  });

  it('says so when there is no portfolio at all', async () => {
    const result = await evaluateG3(store, vec(0));
    assert.equal(result.tripped, false);
    assert.equal(result.matches.length, 0);
    assert.match(result.plainName, /No portfolio/);
  });
});
