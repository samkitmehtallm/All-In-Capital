/**
 * Gate G4 — integrity. Derived from the reconciliation checks, no extra model call.
 *
 * The brief allows "deterministic checks plus a model" here. The model is omitted
 * on purpose: every signal G4 needs has already been computed deterministically in
 * step 3 — deck against form, market arithmetic, credentials across documents — and
 * asking a model whether those findings "look like a problem" adds a judgement call
 * on top of arithmetic that is already certain. It would also be the one place in
 * the pipeline where an allegation could be generated rather than a question asked.
 *
 * "Ask for the numbers; never allege" (brief §6) is why every reason here is a
 * question about a discrepancy, not a claim about a founder's honesty.
 */

import type { ReconCheck } from '../pipeline/reconcile';
import type { GateCitation, GateResult } from './g1-stage-cheque';

export interface G4Result extends Omit<GateResult, 'gateKey'> {
  gateKey: 'g4_integrity';
  redChecks: ReconCheck[];
}

export function evaluateG4(checks: ReconCheck[]): G4Result {
  const red = checks.filter((c) => c.severity === 'red');

  const citations: GateCitation[] = red.map((c) => ({
    kind: 'deck',
    ref: c.title,
    quote: c.formula ?? c.plain,
  }));

  if (red.length === 0) {
    return {
      gateKey: 'g4_integrity',
      tripped: false,
      plainName: 'Numbers reconcile',
      reason: 'The deck and the form agree, and the market arithmetic holds.',
      citations: [],
      decidedBy: 'code',
      redChecks: [],
    };
  }

  // Name the kind of problem, not the count. "Three red checks" tells Riya nothing
  // she can act on; "the market size does not follow from its own inputs" does.
  const kinds = new Set(
    red.map((c) =>
      c.checkKey.startsWith('market')
        ? 'market arithmetic'
        : c.checkKey.startsWith('credential')
          ? 'credentials'
          : 'deck and form disagree',
    ),
  );

  const plainName =
    kinds.size === 1
      ? { 'market arithmetic': 'Market maths does not hold', credentials: 'Credentials need checking', 'deck and form disagree': 'Deck and form disagree' }[
          [...kinds][0] as 'market arithmetic' | 'credentials' | 'deck and form disagree'
        ]!
      : 'Several numbers need checking';

  return {
    gateKey: 'g4_integrity',
    tripped: true,
    plainName,
    reason: red.map((c) => c.plain).join(' '),
    citations,
    decidedBy: 'code',
    redChecks: red,
  };
}
