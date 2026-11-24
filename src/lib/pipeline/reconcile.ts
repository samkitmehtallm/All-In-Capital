/**
 * Pipeline step 3 — reconcile. Pure code, no model.
 *
 * Four families of check, each carrying the arithmetic that produced it so a
 * partner can verify it by eye:
 *
 *   1. Market tiers recomputed from the deck's own inputs (market-math.ts).
 *   2. Deck against form for every metric both state, within 5%.
 *   3. Targets that read as actuals ("In 12 months: 150 paying firms").
 *   4. Credentials the deck claims that the form does not support.
 *
 * Severity is red / warn / info, and the wording asks rather than alleges. G4 says
 * "ask for the numbers; never allege" — a founder whose deck says 31 and whose form
 * says 24 has usually counted trials, not lied, and an accusation gets a true answer
 * far less often than a question does.
 */

import { recomputeMarket, type MarketRecompute, type MarketTier } from '../market-math';
import { agreesWithinTolerance, formatINR, parseAmount, parseCount, parsePercent } from '../units';

export type Severity = 'red' | 'warn' | 'info';

export interface ReconCheck {
  checkKey: string;
  title: string;
  severity: Severity;
  /** The arithmetic, written out. Null where the check is not numeric. */
  formula: string | null;
  expected: string | null;
  found: string | null;
  /** One sentence, plain words, phrased as a question where it is a discrepancy. */
  plain: string;
}

// ---------------------------------------------------------------------------
// 1. Market size
// ---------------------------------------------------------------------------

/**
 * Pull the market slide's tiers out of a deck page.
 *
 * These decks write the tier, the figure and the derivation on one line:
 *   "TAM INR 91,200 Cr 38M urban households ... x INR 2,400 a year"
 * The figure runs to the start of the derivation, which begins at the first digit
 * after the amount. Splitting on the next tier label bounds each one.
 */
export function parseMarketSlide(pageText: string): Array<{ tier: MarketTier; claimed: string; inputs: string }> {
  const text = pageText.replace(/\s+/g, ' ');
  // "T AM" appears in these exports where the PDF letter-spaced the heading.
  const normalised = text.replace(/\bT\s+AM\b/g, 'TAM');

  const tiers: MarketTier[] = ['TAM', 'SAM', 'SOM'];
  const positions = tiers
    .map((tier) => ({ tier, index: normalised.indexOf(tier) }))
    .filter((p) => p.index >= 0)
    .sort((a, b) => a.index - b.index);

  const out: Array<{ tier: MarketTier; claimed: string; inputs: string }> = [];

  for (let i = 0; i < positions.length; i += 1) {
    const { tier, index } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].index : normalised.length;
    const block = normalised.slice(index + tier.length, end).trim();

    // The claimed figure is the leading amount; the derivation is what follows.
    const amount = /^(?:INR|₹|Rs\.?)?\s*[0-9][0-9,.]*\s*(?:lakh\s*)?(?:Cr|crore|L|lakh)?/i.exec(block);
    if (!amount) continue;
    const claimed = amount[0].trim();
    const inputs = block.slice(amount[0].length).trim();
    if (!claimed || !inputs) continue;
    out.push({ tier, claimed, inputs });
  }

  return out;
}

/**
 * A market figure with no derivation beside it.
 *
 * Three of the ten decks state one top-down number and stop: "INR 1.5 lakh Cr
 * annual urban rent paid in India. Capturing just 1% would mean...". There is
 * nothing to recompute, which is not the same as nothing being wrong — R4 says a
 * missing number lowers the score and is never skipped. So the absence is reported
 * as its own check rather than the deck quietly passing.
 */
function underivedMarketCheck(deckPages: string[]): ReconCheck[] {
  // Look only at pages that actually talk about the market. Scanning the whole
  // deck picks up the raise from the title slide — CAPilot's "Raising INR 1.5 Cr"
  // was being reported as its market size, which is both wrong and the kind of
  // wrong that makes a partner stop trusting the rest of the column.
  const marketPages = deckPages.filter((page) =>
    /\bmarket\b|\bTAM\b|\bT\s+AM\b|\bopportunity\b/i.test(page),
  );
  if (marketPages.length === 0) return [];

  // The market figure is the largest amount on that page, by some distance.
  let biggest: { text: string; inr: number } | null = null;
  for (const page of marketPages) {
    const text = page.replace(/\s+/g, ' ');
    for (const m of text.matchAll(/(?:INR|₹)\s*[0-9][0-9,.]*\s*(?:lakh\s*)?(?:Cr|crore)/gi)) {
      const parsed = parseAmount(m[0]);
      if (parsed && (!biggest || parsed.inr > biggest.inr)) {
        biggest = { text: m[0].trim(), inr: parsed.inr };
      }
    }
  }
  if (!biggest) return [];

  return [
    {
      checkKey: 'market_no_derivation',
      title: 'Market size',
      severity: 'warn',
      formula: null,
      expected: 'the inputs the figure came from',
      found: `${biggest.text} stated with no derivation`,
      plain:
        'The market figure is stated without the inputs behind it, so there is nothing ' +
        'to check it against. Worth asking how they got to it.',
    },
  ];
}

export function marketChecks(deckPages: string[]): ReconCheck[] {
  const checks: ReconCheck[] = [];

  for (const [i, page] of deckPages.entries()) {
    const tiers = parseMarketSlide(page);
    if (tiers.length === 0) continue;

    for (const { tier, claimed, inputs } of tiers) {
      const result: MarketRecompute = recomputeMarket(tier, claimed, inputs);
      checks.push({
        checkKey: `market_${tier.toLowerCase()}`,
        title: `${tier} on page ${i + 1}`,
        severity: result.severity === 'ok' ? 'info' : result.severity,
        formula: result.formula,
        expected: result.computedInr === null ? null : formatINR(result.computedInr),
        found: result.claimedText,
        plain:
          result.severity === 'red' && result.factor !== null
            ? `${result.plain} Worth asking which figure they meant.`
            : result.plain,
      });
    }
    break; // one market slide per deck
  }

  // No tiers anywhere: either there is no market claim, or there is one with no
  // working. The second case is a gap worth naming.
  if (checks.length === 0) return underivedMarketCheck(deckPages);

  return checks;
}

// ---------------------------------------------------------------------------
// 2. Deck against form
// ---------------------------------------------------------------------------

type Kind = 'amount' | 'count' | 'percent';

interface Reconcilable {
  key: string;
  title: string;
  /** Form labels to read, in order of preference. */
  formLabels: string[];
  /** The canonical metric a deck claim must carry to be compared. Exact match. */
  canonical: string;
  /**
   * Which figure to take when the form field states several.
   *
   * Pumpwise's Revenue field holds a cumulative figure, a hardware split and a
   * monthly subscription; only the last is comparable with a monthly deck figure.
   * Suppressing every multi-figure field removed four false flags but also demoted
   * a real one (Talkbook's INR 1.9 L against the deck's INR 2.1 L, because the same
   * field mentions INR 500 per seat). Naming the figure recovers both.
   */
  formHint?: RegExp;
  kind: Kind;
  /** Why a mismatch matters, in Riya's terms. */
  question: string;
}

/**
 * What is safe to compare across the two documents.
 *
 * Each row pairs ONE form field with ONE canonical metric. Nothing is compared on
 * a keyword, because a keyword match turned "INR 48,000 CAC per team" into a team
 * of 48,000 and compared payment volume against net revenue.
 */
const RECONCILABLE: Reconcilable[] = [
  {
    key: 'paying_customers',
    title: 'Paying customers',
    formLabels: ['Customers', 'Active customers'],
    canonical: 'paying_customers',
    kind: 'count',
    // "11 pilots started since March 2026. 6 converted to paid" -> 6.
    formHint: /([0-9][0-9,]*)\s*(?:\w+\s+){0,3}?(?:converted to paid|paying|paid)/i,
    question: 'Does the deck count trials or pilots as paying?',
  },
  {
    key: 'team_size',
    title: 'Team size',
    formLabels: ['Team size'],
    canonical: 'team_size',
    kind: 'count',
    question: 'Does the deck count advisors or contractors as team?',
  },
  {
    key: 'monthly_revenue',
    title: 'Monthly revenue',
    formLabels: ['Revenue'],
    canonical: 'monthly_revenue',
    kind: 'amount',
    // "INR 14.2 L cumulative ... Monthly recurring subscription INR 1.05 L" and
    // "MRR INR 1.9 L (INR 500 per seat per month)" both resolve correctly.
    formHint: /(?:monthly recurring|recurring|MRR|monthly)[^0-9]{0,24}((?:INR|₹)?\s*[0-9][0-9,.]*\s*(?:L|lakh|Cr|crore)?)/i,
    question: 'Which month does each figure refer to?',
  },
  {
    key: 'registered_users',
    title: 'Registered users',
    formLabels: ['Users'],
    canonical: 'registered_users',
    kind: 'count',
    question: 'Are these the same users on both documents?',
  },
];

function readValue(text: string | null | undefined, kind: Kind): number | null {
  if (!text) return null;
  if (kind === 'amount') return parseAmount(text)?.inr ?? null;
  if (kind === 'percent') return parsePercent(text);
  return parseCount(text);
}

/**
 * How many separate figures does this form field state?
 *
 * Form fields are free text and frequently hold several. Pumpwise's Revenue reads
 * "INR 14.2 L cumulative, of which hardware INR 13.3 L. Monthly recurring
 * subscription INR 1.05 L" — three figures, of which only the last is monthly.
 * Taking the first and declaring a contradiction against the deck produced four
 * false red flags out of seventeen, every one of them on a multi-figure field.
 *
 * Where there is more than one, the two documents are not comparable on this metric
 * by arithmetic alone, and saying so is better than asserting a discrepancy that
 * does not exist. Riya loses trust in the column far faster from one confident
 * wrong flag than from an honest "cannot compare".
 */
function countFigures(text: string, kind: Kind): number {
  const pattern =
    kind === 'percent'
      ? /[0-9]+(?:\.[0-9]+)?\s*%/g
      : /[0-9][0-9,]*(?:\.[0-9]+)?/g;
  return (text.match(pattern) ?? []).length;
}

export interface ClaimLike {
  metric: string;
  canonical?: string;
  value_text: string | null;
  value_num: number | null;
  is_target: boolean;
  quote: string;
  page: number;
}

export function deckVsFormChecks(
  claims: ClaimLike[],
  formFields: Array<{ label: string; value: string }>,
): ReconCheck[] {
  const checks: ReconCheck[] = [];
  const field = (label: string) => formFields.find((f) => f.label === label)?.value ?? null;

  for (const spec of RECONCILABLE) {
    const formRaw = spec.formLabels.map(field).find((v) => v !== null) ?? null;
    const formValue = readValue(formRaw, spec.kind);
    if (formValue === null || formRaw === null) continue;

    // Where the field states several figures, try the hint first.
    let resolvedForm = formValue;
    let ambiguous = countFigures(formRaw, spec.kind) > 1;

    if (ambiguous && spec.formHint) {
      const hinted = spec.formHint.exec(formRaw);
      const hintedValue = hinted ? readValue(hinted[1], spec.kind) : null;
      // A hint can land on the wrong number. CareCorner's revenue field says "The
      // first clinic reached monthly breakeven in month 8", and the monthly hint
      // matched the 8, producing a reported monthly revenue of eight rupees. A
      // rupee figure with no unit and a value under a thousand is not revenue, so
      // the hint is rejected rather than trusted.
      const plausible =
        hintedValue !== null &&
        (spec.kind !== 'amount' || hintedValue >= 1000 || /L|lakh|Cr|crore/i.test(hinted?.[1] ?? ''));
      if (plausible && hintedValue !== null) {
        resolvedForm = hintedValue;
        ambiguous = false;
      }
    }

    // Still several figures and no hint matched: not comparable by arithmetic.
    // Report the ambiguity instead of inventing a contradiction.
    if (ambiguous) {
      checks.push({
        checkKey: `deck_vs_form_${spec.key}`,
        title: spec.title,
        severity: 'info',
        formula: null,
        expected: null,
        found: formRaw.length > 90 ? `${formRaw.slice(0, 90)}…` : formRaw,
        plain:
          `The form gives more than one figure for ${spec.title.toLowerCase()}, so the deck ` +
          `cannot be checked against it directly. ${spec.question}`,
      });
      continue;
    }

    // Actuals only, and an exact canonical match. A target is handled separately.
    const candidates = claims.filter(
      (c) =>
        !c.is_target &&
        c.canonical === spec.canonical &&
        readValue(c.value_text ?? String(c.value_num ?? ''), spec.kind) !== null,
    );
    if (candidates.length === 0) continue;

    // The largest deck figure is the one worth asking about: a deck that overstates
    // picks its most flattering number, and that is the one Riya will be quoted.
    const deckClaim = candidates.reduce((a, b) => {
      const av = readValue(a.value_text ?? String(a.value_num ?? ''), spec.kind) ?? 0;
      const bv = readValue(b.value_text ?? String(b.value_num ?? ''), spec.kind) ?? 0;
      return bv > av ? b : a;
    });
    const deckValue = readValue(deckClaim.value_text ?? String(deckClaim.value_num ?? ''), spec.kind)!;

    const agrees = agreesWithinTolerance(deckValue, resolvedForm);
    const fmt = (n: number) => (spec.kind === 'amount' ? formatINR(n) : String(n));

    checks.push({
      checkKey: `deck_vs_form_${spec.key}`,
      title: spec.title,
      severity: agrees ? 'info' : 'red',
      formula: `deck ${fmt(deckValue)} vs form ${fmt(resolvedForm)} (tolerance 5%)`,
      expected: fmt(resolvedForm),
      found: fmt(deckValue),
      plain: agrees
        ? `${spec.title} agrees between the deck and the form.`
        : `The deck says ${fmt(deckValue)} and the form says ${fmt(resolvedForm)}. ${spec.question}`,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 3. Targets presented as actuals
// ---------------------------------------------------------------------------

export function targetChecks(claims: ClaimLike[]): ReconCheck[] {
  const targets = claims.filter((c) => c.is_target);
  if (targets.length === 0) return [];

  return [
    {
      checkKey: 'targets_not_actuals',
      title: 'Targets',
      severity: 'info',
      formula: null,
      expected: null,
      found: `${targets.length} forward-looking figure${targets.length === 1 ? '' : 's'}`,
      plain:
        `${targets.length} figure${targets.length === 1 ? ' is a target' : 's are targets'}, not ` +
        `something achieved. They are excluded from every comparison above.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Credentials
// ---------------------------------------------------------------------------

/**
 * Credentials the deck claims that the form does not support.
 *
 * EarnWise's deck says "Ex-Goldman Sachs. Ex-Google. MBA, IIM Ahmedabad"; its form
 * says a ten-week internship at an investment bank, a five-month contract through a
 * vendor, and an MBA at a tier-2 school. Both describe the same person. Neither is
 * necessarily dishonest — but the gap is the single most useful thing on the file,
 * and it is found by comparing two documents rather than by reading either.
 */
const CREDENTIAL_PATTERNS: Array<{ re: RegExp; label: string; formEvidence: RegExp }> = [
  { re: /\bex[- ]goldman(?:\s+sachs)?\b/i, label: 'Ex-Goldman Sachs', formEvidence: /goldman/i },
  { re: /\bex[- ]google\b/i, label: 'Ex-Google', formEvidence: /\bgoogle\b/i },
  { re: /\bex[- ](?:amazon|meta|facebook|microsoft|mckinsey|bain|bcg)\b/i, label: 'Ex-big-name employer', formEvidence: /amazon|meta|facebook|microsoft|mckinsey|bain|bcg/i },
  { re: /\bIIM\s*(?:Ahmedabad|Bangalore|Calcutta|A\b|B\b|C\b)/i, label: 'IIM', formEvidence: /\bIIM\b/i },
  { re: /\bIIT\s*(?:Madras|Bombay|Delhi|Kanpur|Kharagpur|Roorkee)/i, label: 'IIT', formEvidence: /\bIIT\b/i },
];

export function credentialChecks(
  deckPages: string[],
  founderBackgrounds: string[],
): ReconCheck[] {
  const deck = deckPages.join(' ').replace(/\s+/g, ' ');
  const form = founderBackgrounds.join(' ').replace(/\s+/g, ' ');
  const checks: ReconCheck[] = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = pattern.re.exec(deck);
    if (!match) continue;
    if (pattern.formEvidence.test(form)) continue;

    checks.push({
      checkKey: `credential_${pattern.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      title: 'Credentials',
      severity: 'red',
      formula: null,
      expected: 'the same claim on the form',
      found: `"${match[0]}" on the deck only`,
      plain:
        `The deck says "${match[0]}". The form describes this differently. ` +
        `Worth asking them to walk through the role.`,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------

export interface ReconcileInput {
  deckPages: string[];
  claims: ClaimLike[];
  formFields: Array<{ label: string; value: string }>;
  founderBackgrounds: string[];
}

export function reconcile(input: ReconcileInput): ReconCheck[] {
  return [
    ...marketChecks(input.deckPages),
    ...deckVsFormChecks(input.claims, input.formFields),
    ...credentialChecks(input.deckPages, input.founderBackgrounds),
    ...targetChecks(input.claims),
  ];
}

/** The worst severity present, for the card chip and for G4. */
export function worstSeverity(checks: ReconCheck[]): Severity {
  if (checks.some((c) => c.severity === 'red')) return 'red';
  if (checks.some((c) => c.severity === 'warn')) return 'warn';
  return 'info';
}
