/**
 * Gate G2 — regulatory dependency. Model, cited.
 *
 * R6: "No company whose existence depends on a favourable regulatory change."
 * Memo 10, Coinlane: "a business whose existence depends on a favourable
 * regulatory change is not one we want to underwrite at pre-seed."
 *
 * The distinction this gate has to hold is narrow and easy to blur. Almost every
 * fintech is *affected* by regulation; Wint Wealth was backed with "the regulatory
 * perimeter for retail bond distribution was evolving" written in its own memo. The
 * question is not whether regulation matters but whether the business STOPS
 * EXISTING if the rules stay as they are. The prompt says so explicitly, because a
 * model asked "is there regulatory risk?" answers yes for all ten.
 */

import { z } from 'zod';

import { callModel } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../gateway/guards';
import type { FounderIdentity } from '../redact';
import type { GateCitation, GateResult } from './g1-stage-cheque';

const G2Schema = z.object({
  depends_on_change: z.boolean(),
  /** One sentence, plain words. */
  reason: z.string().min(1),
  /** A quote from the application supporting the finding, or null. */
  quote: z.string().nullable(),
  page: z.number().int().nullable(),
});

export const G2_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['depends_on_change', 'reason', 'quote', 'page'],
  properties: {
    depends_on_change: { type: 'boolean' },
    reason: { type: 'string' },
    quote: { type: ['string', 'null'] },
    page: { type: ['integer', 'null'] },
  },
} as const;

const SYSTEM = `You judge ONE question about a startup application for a pre-seed fund.

The question: does this business only exist if a regulation CHANGES in its favour?

This is narrower than "is it affected by regulation". Say false for:
- a business regulators already permit, even if the rules are strict or evolving;
- a business that needs a licence it can apply for;
- a lender that depends on an NBFC partner, which is a risk-ownership question,
  not a regulatory-change question.

Say true only when the company has no lawful business at all unless rules move, or
when the founders' own plan rests on rules becoming friendlier. The fund passed on a
crypto exchange for exactly this: the founder "spoke confidently about regulation,
but his answers amounted to a bet that the rules would become friendlier. There was
no plan for the scenario in which they did not."

Quote the application where it supports your answer, copied exactly, under 25 words.

${DATA_NOT_INSTRUCTIONS}`;

export interface G2Input {
  applicationId: string;
  company: string;
  oneLiner: string | null;
  sector: string | null;
  /** Redacted text of the pages most likely to discuss dependencies and risk. */
  pages: string[];
  founders?: FounderIdentity[];
  traceId?: string;
}

export interface G2Result extends Omit<GateResult, 'gateKey'> {
  gateKey: 'g2_regulatory';
  costInr: number;
}

export async function evaluateG2(input: G2Input): Promise<G2Result> {
  const response = await callModel({
    step: 'gate:g2_regulatory',
    system: SYSTEM,
    user:
      `Company: ${input.company}${input.sector ? ` (${input.sector})` : ''}\n` +
      `What it does: ${input.oneLiner ?? 'not stated'}\n\n` +
      input.pages.map((p, i) => `--- page ${i + 1} ---\n${p.trim()}`).join('\n\n'),
    temperature: 0,
    responseSchema: G2_JSON_SCHEMA,
    founders: input.founders,
    applicationId: input.applicationId,
    traceId: input.traceId,
  });

  const parsed = G2Schema.safeParse(response.json);

  if (!parsed.success) {
    // An unreadable answer is not a clean bill of health. It routes to Riya with
    // the reason, the same as any other step that could not finish.
    return {
      gateKey: 'g2_regulatory',
      tripped: true,
      plainName: 'Regulatory check did not finish',
      reason: 'The regulatory question could not be assessed automatically. Worth a look.',
      citations: [],
      decidedBy: 'model',
      costInr: response.costInr,
    };
  }

  const out = parsed.data;
  const citations: GateCitation[] =
    out.quote && out.page !== null ? [{ kind: 'deck', ref: `page ${out.page}`, quote: out.quote }] : [];

  return {
    gateKey: 'g2_regulatory',
    tripped: out.depends_on_change,
    plainName: out.depends_on_change ? 'Depends on the rules changing' : 'No regulatory dependency',
    reason: out.reason,
    citations,
    decidedBy: 'model',
    costInr: response.costInr,
  };
}
