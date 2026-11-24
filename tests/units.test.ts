import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agreesWithinTolerance,
  CRORE,
  formatINR,
  LAKH,
  parseAmount,
  parseCount,
  parsePercent,
  powerOfTenFactor,
  relativeDelta,
} from '../src/lib/units';

describe('parseAmount', () => {
  it('reads the forms of rupee amount these decks actually use', () => {
    // Every string below is lifted verbatim from one of the ten applications.
    assert.equal(parseAmount('INR 1.5 Cr')?.inr, 1.5 * CRORE);
    assert.equal(parseAmount('INR 2.5 Cr')?.inr, 2.5 * CRORE);
    assert.equal(parseAmount('INR 30 Cr')?.inr, 30 * CRORE);
    assert.equal(parseAmount('INR 180 Cr post-money')?.inr, 180 * CRORE);
    assert.equal(parseAmount('INR 9.4 L annualised')?.inr, 9.4 * LAKH);
    assert.equal(parseAmount('Monthly recurring revenue INR 78,000')?.inr, 78_000);
    assert.equal(parseAmount('INR 16.5 L in October 2026')?.inr, 16.5 * LAKH);
  });

  it('reads lakh crore, which is a different number from both lakh and crore', () => {
    // Compared with a tolerance: 1.14 * LAKH * CRORE and 1.14 * (LAKH * CRORE)
    // are different floats, and neither is "the" right answer to assert against.
    const close = (a: number | undefined, b: number) =>
      assert.ok(a !== undefined && Math.abs((a - b) / b) < 1e-9, `${a} vs ${b}`);
    // CareCorner page 5 states a TAM of "INR 1.14 lakh Cr". Reading that as 1.14
    // crore, or as 1.14 lakh, is a factor of 1e5 or 1e7 wrong respectively.
    close(parseAmount('INR 1.14 lakh Cr')?.inr, 1.14 * LAKH * CRORE);
    close(parseAmount('TAM INR 9.4 lakh Cr')?.inr, 9.4 * LAKH * CRORE);
    close(parseAmount('INR 17 lakh Cr')?.inr, 17 * LAKH * CRORE);
    assert.equal(parseAmount('INR 1.4 lakh Cr')?.multiplierText, 'lakh Cr');
  });

  it('keeps the multiplier it applied, so a check can show its working', () => {
    const parsed = parseAmount('INR 91,200 Cr');
    assert.equal(parsed?.inr, 91_200 * CRORE);
    assert.equal(parsed?.multiplier, CRORE);
    assert.equal(parsed?.mantissaText, '91,200');
  });

  it('returns null rather than zero when there is no number to read', () => {
    // G1 routes an unreadable amount to Kushal with the text it could not read.
    // Silently becoming 0 would instead place it inside the cheque range.
    assert.equal(parseAmount('We are raising funds to grow.'), null);
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount(null), null);
  });
});

describe('formatINR', () => {
  it('formats the way a partner reads', () => {
    assert.equal(formatINR(2.5 * CRORE), '₹2.5 Cr');
    assert.equal(formatINR(16.5 * LAKH), '₹16.5 L');
    assert.equal(formatINR(78_000), '₹78,000');
    assert.equal(formatINR(2 * CRORE), '₹2 Cr');
  });
});

describe('percent and count', () => {
  it('reads percentages as fractions', () => {
    assert.equal(parsePercent('Gross margin 48%'), 0.48);
    assert.equal(parsePercent('90-day repeat rate was 31%'), 0.31);
    assert.equal(parsePercent('no number here'), null);
  });

  it('reads the leading count out of a messy field', () => {
    assert.equal(parseCount('14, including 3 doctors'), 14);
    assert.equal(parseCount('5 (founder, 2 outsourced developers)'), 5);
    assert.equal(parseCount('1,600 workers enabled'), 1600);
  });
});

describe('agreement tolerance', () => {
  it('treats a 5% gap as agreement and more as disagreement', () => {
    assert.equal(agreesWithinTolerance(100, 104), true);
    assert.equal(agreesWithinTolerance(100, 96), true);
    assert.equal(agreesWithinTolerance(100, 90), false);
  });

  it('is symmetric', () => {
    assert.equal(relativeDelta(100, 90), relativeDelta(90, 100));
  });
});

describe('powerOfTenFactor', () => {
  it('names a clean x10 so the check reads as a typo, not an accusation', () => {
    // GrainKind page 6: TAM stated as 91,200 Cr from inputs giving 9,120 Cr.
    assert.equal(powerOfTenFactor(91_200 * CRORE, 9_120 * CRORE), 10);
    assert.equal(powerOfTenFactor(9_120 * CRORE, 91_200 * CRORE), 0.1);
    assert.equal(powerOfTenFactor(100, 1), 100);
  });

  it('stays silent when the gap is not a power of ten', () => {
    // A 2.3x gap is a different conversation and should not be labelled "x10".
    assert.equal(powerOfTenFactor(230, 100), null);
    assert.equal(powerOfTenFactor(100, 100), null);
    assert.equal(powerOfTenFactor(100, 0), null);
  });
});
