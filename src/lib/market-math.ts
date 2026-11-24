/**
 * TAM / SAM / SOM recomputation.
 *
 * Decks state a market figure and, usually on the same line, the inputs it came
 * from: "TAM INR 91,200 Cr — 38M urban households x INR 2,400 a year". This module
 * recomputes the product from those inputs and compares it with the stated figure.
 *
 * Two things matter for how the result reads on screen:
 *   1. The formula is reported back, so a partner can check it by eye.
 *   2. A clean power-of-ten gap is named as "x10", because that is a typo a founder
 *      can answer, not an accusation (brief §6, G4: "ask for the numbers; never allege").
 */

import { CRORE, LAKH, parseAmount, powerOfTenFactor, relativeDelta } from './units';

export type MarketTier = 'TAM' | 'SAM' | 'SOM';

export interface Operand {
  /** Value as a plain number: a count, a rupee amount, or a bare multiplier. */
  value: number;
  /** 'count' | 'INR' | 'multiplier' */
  kind: 'count' | 'INR' | 'multiplier';
  /** The segment of the slide this came from. */
  text: string;
}

export interface MarketRecompute {
  tier: MarketTier;
  /** The figure the deck states. */
  claimedInr: number | null;
  claimedText: string;
  /** The product of the inputs the deck itself gives. */
  computedInr: number | null;
  operands: Operand[];
  /** Human-readable arithmetic, e.g. "38,000,000 x 2,400 = 91,200,000,000". */
  formula: string;
  /** null when the two agree within tolerance. */
  factor: number | null;
  severity: 'red' | 'warn' | 'info' | 'ok';
  plain: string;
}

/**
 * Currency marker, with word boundaries.
 *
 * Without the boundaries, `Rs` matches the "rs" inside "workers" and "customers",
 * which silently turned "10M gig and shift workers" into a rupee amount of 10.
 */
const CURRENCY_RE = /₹|\bINR\b|\bRs\.?/i;

/**
 * Narration that precedes the operative number on a SOM line.
 *
 * "In 3 years: 400 customers x 60 sensors" must yield 400, not the 3 from the
 * horizon. Stripping the prefix is safer than hunting for the largest number,
 * which would break "In 3 years: 2% of SAM stores (9,000)".
 */
const HORIZON_PREFIX_RE = /^\s*(?:in|by|within|over)\s+(?:the\s+)?(?:next\s+)?[0-9]+\s*(?:years?|yrs?|months?)\s*[:,-]?\s*/i;

/** Counts in decks are written in Western units; money in Indian ones. */
const COUNT_SUFFIXES: Array<{ re: RegExp; mult: number }> = [
  { re: /([0-9][0-9,.]*)\s*(?:mn|m)\b/i, mult: 1e6 },
  { re: /([0-9][0-9,.]*)\s*(?:bn|b)\b/i, mult: 1e9 },
  { re: /([0-9][0-9,.]*)\s*k\b/i, mult: 1e3 },
  { re: /([0-9][0-9,.]*)\s*lakh\b/i, mult: LAKH },
  { re: /([0-9][0-9,.]*)\s*(?:crore|cr)\b/i, mult: CRORE },
];

/**
 * Pull one operand out of a slide segment.
 *
 * Percentages are stripped first: "2% of SAM stores (9,000)" means 9,000 stores,
 * and the 2 is narration. Where a parenthesis holds the number, it wins — that is
 * the convention these decks use for a derived count.
 */
export function parseOperand(segment: string): Operand | null {
  const text = segment.trim();
  if (!text) return null;

  // Bare multiplier: a slide that ends "x 12".
  if (/^[0-9]{1,3}$/.test(text)) {
    return { value: Number(text), kind: 'multiplier', text };
  }

  const stripped = text.replace(HORIZON_PREFIX_RE, '').replace(/[0-9][0-9.]*\s*%/g, ' ');

  // A parenthesised figure is the operative one.
  const paren = /\(([^)]*[0-9][^)]*)\)/.exec(stripped);
  const scope = paren ? paren[1] : stripped;

  if (CURRENCY_RE.test(scope)) {
    const amount = parseAmount(scope);
    if (amount) return { value: amount.inr, kind: 'INR', text };
  }

  for (const suffix of COUNT_SUFFIXES) {
    const m = suffix.re.exec(scope);
    if (m) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) return { value: n * suffix.mult, kind: 'count', text };
    }
  }

  const plain = /([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(scope);
  if (plain) {
    const n = Number(plain[1].replace(/,/g, ''));
    if (Number.isFinite(n)) {
      return { value: n, kind: CURRENCY_RE.test(scope) ? 'INR' : 'count', text };
    }
  }

  return null;
}

/** Split "A x B x 12" into its segments. Whitespace is required around the x. */
export function splitFormula(inputs: string): string[] {
  return inputs
    .split(/\s+[x×]\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Recompute one market tier.
 *
 * `claimed` is the figure as stated ("INR 91,200 Cr"); `inputs` is the derivation
 * line beside it. A dropped "x12" is restored by `requireMonthlyToAnnual` when the
 * inputs describe a monthly figure but no annualisation appears.
 */
export function recomputeMarket(
  tier: MarketTier,
  claimed: string,
  inputs: string,
): MarketRecompute {
  const claimedAmount = parseAmount(claimed);
  const segments = splitFormula(inputs);
  const operands = segments.map(parseOperand).filter((o): o is Operand => o !== null);

  let computedInr: number | null = null;
  if (operands.length >= 2) {
    computedInr = operands.reduce((acc, o) => acc * o.value, 1);
  }

  // A monthly amount multiplied only by a count, with no annualiser in sight,
  // is a dropped x12. Restore it from the page's own wording rather than guessing.
  const monthly = /\b(?:a month|monthly|per month|month)\b/i.test(inputs);
  const annual = /\b(?:a year|annual|per year|yearly|x\s*12)\b/i.test(inputs);
  const hasTwelve = operands.some((o) => o.kind === 'multiplier' && o.value === 12);
  let restoredTwelve = false;
  if (computedInr !== null && monthly && !annual && !hasTwelve) {
    computedInr *= 12;
    restoredTwelve = true;
  }

  const formula = operands.length
    ? `${operands.map((o) => fmtOperand(o)).join(' × ')}${restoredTwelve ? ' × 12 (monthly → annual)' : ''}` +
      (computedInr !== null ? ` = ${Math.round(computedInr).toLocaleString('en-IN')}` : '')
    : 'inputs not stated on the page';

  const claimedInr = claimedAmount?.inr ?? null;
  let factor: number | null = null;
  let severity: MarketRecompute['severity'] = 'ok';
  let plain = `${tier} matches the inputs on the page.`;

  if (claimedInr === null || computedInr === null) {
    severity = 'info';
    plain = `${tier} could not be checked: the page does not give both a figure and its inputs.`;
  } else {
    const delta = relativeDelta(claimedInr, computedInr);
    if (delta > 0.05) {
      factor = powerOfTenFactor(claimedInr, computedInr);
      severity = 'red';
      plain =
        factor !== null
          ? `${tier} is ${formatFactor(factor)} the figure its own inputs give.`
          : `${tier} does not match the inputs on the same page.`;
    }
  }

  return {
    tier,
    claimedInr,
    claimedText: claimed.trim(),
    computedInr,
    operands,
    formula,
    factor,
    severity,
    plain,
  };
}

function fmtOperand(o: Operand): string {
  const n = Math.round(o.value).toLocaleString('en-IN');
  return o.kind === 'INR' ? `₹${n}` : n;
}

function formatFactor(factor: number): string {
  if (factor > 1) return `${factor}× larger than`;
  return `${Math.round(1 / factor)}× smaller than`;
}
