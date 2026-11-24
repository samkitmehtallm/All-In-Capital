/**
 * Indian money units.
 *
 * Arithmetic happens here, never in a model (brief §2.2). Decks mix "INR 78,000",
 * "INR 9.4 L", "INR 2.5 Cr" and "INR 1.4 lakh Cr" on neighbouring slides, and a
 * dropped or doubled multiplier is one of the things this system exists to catch.
 *
 * Canonical representation is rupees as a plain number.
 */

export const LAKH = 1e5;
export const CRORE = 1e7;

export type Unit = 'INR' | 'pct' | 'count' | 'months' | 'x';

export interface ParsedAmount {
  /** Canonical value in rupees. */
  inr: number;
  /** The multiplier that was applied, e.g. 1e7 for "Cr". */
  multiplier: number;
  /** The multiplier word(s) as written, e.g. "lakh Cr". */
  multiplierText: string;
  /** The numeric part as written, e.g. "1.4". */
  mantissaText: string;
  /** The whole matched string. */
  raw: string;
}

const MULTIPLIER_WORDS: Array<{ re: RegExp; value: number; canonical: string }> = [
  // Longest first: "lakh crore" must win over "lakh" and over "crore".
  { re: /lakh\s*crore|lakh\s*cr\b|lac\s*crore|lac\s*cr\b/i, value: LAKH * CRORE, canonical: 'lakh Cr' },
  { re: /thousand\s*crore|thousand\s*cr\b/i, value: 1e3 * CRORE, canonical: 'thousand Cr' },
  { re: /crore|crores|cr\b/i, value: CRORE, canonical: 'Cr' },
  { re: /lakhs?|lacs?|\bL\b/i, value: LAKH, canonical: 'L' },
  { re: /thousand|\bk\b/i, value: 1e3, canonical: 'thousand' },
];

/**
 * Parse one Indian money amount out of a string.
 *
 * Returns null rather than guessing when there is no number, so an unreadable
 * amount is flagged with the text it could not read (gate G1) instead of
 * silently becoming zero.
 */
export function parseAmount(input: string | null | undefined): ParsedAmount | null {
  if (!input) return null;
  const text = String(input).replace(/ /g, ' ');

  // Number, then optionally a multiplier word within the next few characters.
  const numRe = /(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z.\s]{0,14})?/;
  const m = numRe.exec(text);
  if (!m) return null;

  const mantissaText = m[1];
  const mantissa = Number(mantissaText.replace(/,/g, ''));
  if (!Number.isFinite(mantissa)) return null;

  const tail = (m[2] ?? '').trim();
  let multiplier = 1;
  let multiplierText = '';
  for (const word of MULTIPLIER_WORDS) {
    if (word.re.test(tail)) {
      multiplier = word.value;
      multiplierText = word.canonical;
      break;
    }
  }

  return {
    inr: mantissa * multiplier,
    multiplier,
    multiplierText,
    mantissaText,
    raw: m[0].trim(),
  };
}

/** Parse, or throw. Use only where a missing number is a programming error. */
export function parseAmountOrThrow(input: string): ParsedAmount {
  const parsed = parseAmount(input);
  if (!parsed) throw new Error(`Could not read an amount from: ${JSON.stringify(input)}`);
  return parsed;
}

/**
 * Format rupees the way a partner reads them: crore above a crore, lakh above a
 * lakh, plain rupees below that. Two significant decimals at most, never more.
 */
export function formatINR(inr: number): string {
  if (!Number.isFinite(inr)) return '—';
  const abs = Math.abs(inr);
  // Above a lakh crore, "₹1,14,000 Cr" is harder to read than "₹1.14 lakh Cr",
  // and the decks themselves switch at exactly this point.
  if (abs >= LAKH * CRORE) return `₹${trimZeros(inr / (LAKH * CRORE))} lakh Cr`;
  if (abs >= CRORE) return `₹${trimZeros(inr / CRORE)} Cr`;
  if (abs >= LAKH) return `₹${trimZeros(inr / LAKH)} L`;
  return `₹${Math.round(inr).toLocaleString('en-IN')}`;
}

function trimZeros(n: number): string {
  const s = n.toFixed(2);
  return s.replace(/\.00$/, '').replace(/(\.[0-9])0$/, '$1');
}

/** Percentage as a fraction: "48%" -> 0.48. Returns null if absent. */
export function parsePercent(input: string | null | undefined): number | null {
  if (!input) return null;
  const m = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(String(input));
  return m ? Number(m[1]) / 100 : null;
}

/** First integer in a string, e.g. team size "14, including 3 doctors" -> 14. */
export function parseCount(input: string | null | undefined): number | null {
  if (!input) return null;
  const m = /([0-9][0-9,]*)/.exec(String(input));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/**
 * Relative difference between two numbers, used by every deck-vs-form check.
 * Defined against the larger magnitude so the result is symmetric and bounded.
 */
export function relativeDelta(a: number, b: number): number {
  if (a === b) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

/** The brief's tolerance for "deck and form agree" (§7.3). */
export const AGREEMENT_TOLERANCE = 0.05;

export function agreesWithinTolerance(a: number, b: number, tolerance = AGREEMENT_TOLERANCE): boolean {
  return relativeDelta(a, b) <= tolerance;
}

/**
 * Is `claimed` a clean power-of-ten multiple of `computed`?
 *
 * GrainKind's deck states a TAM of ₹91,200 Cr from inputs that give ₹9,120 Cr.
 * Naming that as "x10" rather than "wrong by 82,080 crore" is the difference
 * between a check a founder can answer and one that just sounds like an accusation.
 */
export function powerOfTenFactor(claimed: number, computed: number): number | null {
  if (computed === 0 || !Number.isFinite(claimed) || !Number.isFinite(computed)) return null;
  const ratio = claimed / computed;
  if (ratio <= 0) return null;
  const exponent = Math.log10(ratio);
  const rounded = Math.round(exponent);
  if (rounded === 0) return null;
  if (Math.abs(exponent - rounded) > 0.02) return null;
  return 10 ** rounded;
}
