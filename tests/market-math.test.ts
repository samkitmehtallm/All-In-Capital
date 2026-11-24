import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseOperand, recomputeMarket, splitFormula } from '../src/lib/market-math';
import { CRORE, LAKH } from '../src/lib/units';

/**
 * Float equality is the wrong assertion here: 190e6 * 6000 is exactly 1.14e12,
 * while writing that expectation as 1.14 * LAKH * CRORE evaluates to
 * 1139999999999.9998. The arithmetic is right; the literal is unrepresentable.
 */
function closeTo(actual: number | null, expected: number, tolerance = 1e-9): void {
  assert.notEqual(actual, null, 'expected a computed figure, got null');
  const delta = Math.abs(((actual as number) - expected) / expected);
  assert.ok(delta < tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

/**
 * Every `claimed` and `inputs` pair below is transcribed from the market slide of a
 * real application in data/raw. If one of these decks is re-exported and a figure
 * changes, this test is the thing that notices.
 */

describe('splitFormula', () => {
  it('splits on a standalone x, not on the x inside a word', () => {
    assert.deepEqual(splitFormula('10M workers x INR 12,000 x 12'), [
      '10M workers',
      'INR 12,000',
      '12',
    ]);
    assert.deepEqual(splitFormula('approx 300K firms'), ['approx 300K firms']);
  });
});

describe('parseOperand', () => {
  it('reads Western count suffixes, which is how these decks write counts', () => {
    assert.equal(parseOperand('38M urban households')?.value, 38e6);
    assert.equal(parseOperand('~300K manufacturing MSMEs with 20+ motors')?.value, 300e3);
    assert.equal(parseOperand('7M sales reps in India')?.value, 7e6);
  });

  it('prefers the number in parentheses, because that is the derived one', () => {
    // "2% of SAM stores (9,000)" means 9,000 stores; the 2 is narration.
    assert.equal(parseOperand('In 3 years: 2% of SAM stores (9,000)')?.value, 9_000);
    assert.equal(parseOperand('In 3 years: 1.5% of SAM households (90,000)')?.value, 90_000);
  });

  it('is not fooled by digits inside a word', () => {
    // Settlr says "2.1M B2B-trading SMEs". The B2B must not win.
    assert.equal(parseOperand('2.1M B2B-trading SMEs')?.value, 2.1e6);
  });

  it('reads a bare trailing multiplier', () => {
    assert.deepEqual(parseOperand('12'), { value: 12, kind: 'multiplier', text: '12' });
  });
});

describe('recomputeMarket — decks whose arithmetic holds', () => {
  it('CareCorner TAM reconciles', () => {
    const r = recomputeMarket('TAM', 'INR 1.14 lakh Cr', '190M Indian households x INR 6,000 a year');
    closeTo(r.computedInr, 1.14 * LAKH * CRORE);
    assert.equal(r.severity, 'ok');
    assert.equal(r.factor, null);
  });

  it('Pumpwise reconciles across all three tiers', () => {
    const tam = recomputeMarket(
      'TAM',
      'INR 16,200 Cr',
      '~300K manufacturing MSMEs with 20+ motors x 60 sensors x INR 9,000 a year',
    );
    closeTo(tam.computedInr, 16_200 * CRORE);
    assert.equal(tam.severity, 'ok');

    const sam = recomputeMarket(
      'SAM',
      'INR 4,536 Cr',
      '~84K firms in Maharashtra, Tamil Nadu and Gujarat clusters x 60 x INR 9,000',
    );
    closeTo(sam.computedInr, 4_536 * CRORE);
    assert.equal(sam.severity, 'ok');

    const som = recomputeMarket('SOM', 'INR 21.6 Cr', 'In 3 years: 400 customers x 60 sensors x INR 9,000');
    closeTo(som.computedInr, 21.6 * CRORE);
    assert.equal(som.severity, 'ok');
  });

  it('Talkbook TAM reconciles', () => {
    const r = recomputeMarket('TAM', 'INR 4,200 Cr', '7M sales reps in India x INR 6,000 per seat a year');
    closeTo(r.computedInr, 4_200 * CRORE);
    assert.equal(r.severity, 'ok');
  });

  it('StockSathi TAM reconciles within rounding', () => {
    // Inputs give 17.28 lakh Cr; the slide rounds to 17. A 1.6% gap is agreement,
    // and flagging it would be the false positive that teaches Riya to ignore flags.
    const r = recomputeMarket(
      'TAM',
      'INR 17 lakh Cr',
      '12M kirana stores x INR 1.2 L monthly purchases x 12',
    );
    closeTo(r.computedInr, 17.28 * LAKH * CRORE);
    assert.equal(r.severity, 'ok');
  });

  it('GrainKind SOM reconciles, even though its TAM does not', () => {
    const r = recomputeMarket(
      'SOM',
      'INR 28.8 Cr',
      'In 3 years: 1.5% of SAM households (90,000) x INR 3,200 a year',
    );
    closeTo(r.computedInr, 28.8 * CRORE);
    assert.equal(r.severity, 'ok');
  });
});

describe('recomputeMarket — the planted errors', () => {
  it('catches GrainKind TAM, stated as 10x the figure its own inputs give', () => {
    const r = recomputeMarket(
      'TAM',
      'INR 91,200 Cr',
      '38M urban households buying packaged breakfast and better-for-you snacks x INR 2,400 a year',
    );
    closeTo(r.claimedInr, 91_200 * CRORE);
    closeTo(r.computedInr, 9_120 * CRORE);
    assert.equal(r.factor, 10);
    assert.equal(r.severity, 'red');
    assert.equal(r.plain, 'TAM is 10× larger than the figure its own inputs give.');
    // The formula is shown so a partner can check it by eye.
    assert.match(r.formula, /3,80,00,000 × ₹2,400 = 91,20,00,00,000/);
  });

  it('catches GrainKind SAM too', () => {
    const r = recomputeMarket(
      'SAM',
      'INR 14,400 Cr',
      '6M households in 8 metros that bought a health-positioned brand online or on quick commerce x INR 2,400',
    );
    closeTo(r.computedInr, 1_440 * CRORE);
    assert.equal(r.factor, 10);
    assert.equal(r.severity, 'red');
  });

  it('catches EarnWise TAM, which understates by 10x', () => {
    // 10M workers x INR 12,000 a month x 12 is 1,44,000 Cr, not 14,400 Cr. The
    // direction is the opposite of GrainKind's, and the check must say so rather
    // than assuming every error inflates.
    const r = recomputeMarket(
      'TAM',
      'INR 14,400 Cr',
      '10M gig and shift workers x INR 12,000 average monthly advance x 12',
    );
    closeTo(r.computedInr, 144_000 * CRORE);
    assert.equal(r.factor, 0.1);
    assert.equal(r.severity, 'red');
    assert.equal(r.plain, 'TAM is 10× smaller than the figure its own inputs give.');
  });

  it('catches Settlr, which is 10x out on every tier', () => {
    const tam = recomputeMarket('TAM', 'INR 9.4 lakh Cr', '2.1M B2B-trading SMEs x INR 4.5 Cr annual B2B payments');
    assert.equal(tam.severity, 'red');
    const sam = recomputeMarket('SAM', 'INR 1.8 lakh Cr', '400K SMEs in 6 metros x INR 4.5 Cr');
    assert.equal(sam.severity, 'red');
    const som = recomputeMarket('SOM', 'INR 6,750 Cr', 'In 3 years: 15,000 SMEs x INR 4.5 Cr');
    assert.equal(som.severity, 'red');
  });
});

describe('recomputeMarket — dropped annualisation', () => {
  it('restores a missing x12 from the page wording and says it did', () => {
    const r = recomputeMarket('TAM', 'INR 12,000 Cr', '10M workers x INR 1,000 a month');
    // Inputs are monthly with no annualiser, so x12 is restored rather than
    // comparing a monthly figure against an annual claim.
    closeTo(r.computedInr, 12_000 * CRORE);
    assert.match(r.formula, /× 12 \(monthly → annual\)/);
    assert.equal(r.severity, 'ok');
  });

  it('does not double-count when the deck already annualises', () => {
    const r = recomputeMarket('TAM', 'INR 12,000 Cr', '10M workers x INR 1,000 a month x 12');
    closeTo(r.computedInr, 12_000 * CRORE);
    assert.doesNotMatch(r.formula, /monthly → annual/);
  });
});

describe('recomputeMarket — nothing to check', () => {
  it('says so rather than inventing a result', () => {
    // RentRoute page 5 gives a figure with no derivation: "INR 1.5 lakh Cr annual
    // urban rent paid in India". That is a gap to name, not a number to verify.
    const r = recomputeMarket('TAM', 'INR 1.5 lakh Cr', 'annual urban rent paid in India');
    assert.equal(r.computedInr, null);
    assert.equal(r.severity, 'info');
    assert.match(r.plain, /does not give both a figure and its inputs/);
  });
});
