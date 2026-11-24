/**
 * Gate G1 — stage and cheque size. Deterministic (brief §6).
 *
 * Pre-seed or seed, first institutional round, raise up to ₹10 Cr, post-money up to
 * ₹40 Cr. No model is involved: these are four comparisons on numbers that were
 * parsed from a form field, and a model asked to do them would occasionally get one
 * wrong in a way nobody could reproduce.
 *
 * A tripped gate sets the lane to "Kushal decides". It never rejects: Kushal sees
 * every outcome before anything is decided, and nothing is auto-rejected or
 * auto-advanced (operating facts).
 *
 * An amount that could not be read is itself a trip, carrying the text it could not
 * read. Treating an unreadable raise as zero would place it inside the range.
 */

import { FUND_RULES } from '../rubric';
import { formatINR, parseAmount } from '../units';

export interface GateCitation {
  kind: 'form' | 'deck' | 'web' | 'portfolio';
  ref: string;
  quote: string;
}

export interface GateResult {
  gateKey: 'g1_stage';
  tripped: boolean;
  /** Plain words for a chip on the board. No codes. */
  plainName: string;
  reason: string;
  citations: GateCitation[];
  decidedBy: 'code' | 'model';
}

export interface G1Input {
  stageDeclared: string | null;
  raiseText: string | null;
  postMoneyText: string | null;
  /** Existing institutional investors, from the form. */
  existingInvestorsText?: string | null;
}

const STAGE_OK = /pre-?seed|seed/i;
const LATER_STAGE = /series\s*[a-z]|pre-?series|growth|bridge/i;

/**
 * Does the form say an institutional round already happened?
 *
 * Angels and grants do not count — the fund is "often the first institutional
 * cheque", and an angel round before it is the normal case, not a disqualifier.
 */
function hasPriorInstitutional(text: string | null | undefined): boolean {
  if (!text) return false;
  return /institutional|seed round|led by .*fund|venture|\bvc\b/i.test(text);
}

export function evaluateG1(input: G1Input): GateResult {
  const citations: GateCitation[] = [];
  const reasons: string[] = [];

  const stage = input.stageDeclared?.trim() ?? '';
  if (stage) {
    citations.push({ kind: 'form', ref: 'Stage (as selected)', quote: stage });
  }

  // 1. Stage.
  if (LATER_STAGE.test(stage)) {
    reasons.push(`The round is ${stage}, which is past the stage this fund invests at`);
  } else if (stage && !STAGE_OK.test(stage)) {
    reasons.push(`The stage reads "${stage}", which is neither pre-seed nor seed`);
  } else if (!stage) {
    reasons.push('The form does not say what stage this round is');
  }

  // 2. Raise.
  const raise = parseAmount(input.raiseText);
  if (input.raiseText) {
    citations.push({ kind: 'form', ref: 'Amount raising', quote: input.raiseText });
  }
  if (!raise) {
    reasons.push(
      input.raiseText
        ? `The raise could not be read from "${input.raiseText}"`
        : 'The form does not state how much is being raised',
    );
  } else if (raise.inr > FUND_RULES.maxRaiseInr) {
    reasons.push(
      `The raise is ${formatINR(raise.inr)}, above the ${formatINR(FUND_RULES.maxRaiseInr)} this fund goes to`,
    );
  }

  // 3. Post-money.
  const post = parseAmount(input.postMoneyText);
  if (input.postMoneyText) {
    citations.push({ kind: 'form', ref: 'Valuation expectation', quote: input.postMoneyText });
  }
  if (!post) {
    reasons.push(
      input.postMoneyText
        ? `The valuation could not be read from "${input.postMoneyText}"`
        : 'The form does not state a valuation',
    );
  } else if (post.inr > FUND_RULES.maxPostMoneyInr) {
    reasons.push(
      `Post-money is ${formatINR(post.inr)}, above the ${formatINR(FUND_RULES.maxPostMoneyInr)} ceiling`,
    );
  }

  // 4. First institutional round.
  if (hasPriorInstitutional(input.existingInvestorsText)) {
    citations.push({
      kind: 'form',
      ref: 'Existing investors',
      quote: input.existingInvestorsText ?? '',
    });
    reasons.push('An institutional round has already happened, so this would not be the first cheque');
  }

  const tripped = reasons.length > 0;
  return {
    gateKey: 'g1_stage',
    tripped,
    plainName: tripped ? plainNameFor(reasons) : 'Within our stage and cheque',
    reason: tripped ? `${reasons.join('. ')}.` : 'Pre-seed or seed, and inside the cheque and valuation range.',
    citations,
    decidedBy: 'code',
  };
}

/**
 * The chip label.
 *
 * Short enough to sit on a card, and specific enough that a partner knows which of
 * the four conditions tripped without opening the application.
 */
function plainNameFor(reasons: string[]): string {
  const joined = reasons.join(' ').toLowerCase();
  if (joined.includes('could not be read') || joined.includes('does not state') || joined.includes('does not say')) {
    return 'Amounts we could not read';
  }
  if (joined.includes('past the stage') || joined.includes('neither pre-seed nor seed')) {
    return 'Later stage than we do';
  }
  if (joined.includes('above the')) {
    return 'Above our cheque size';
  }
  return 'Not the first institutional cheque';
}
