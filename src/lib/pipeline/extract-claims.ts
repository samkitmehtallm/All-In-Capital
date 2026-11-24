/**
 * Pipeline step 2 — extract claims.
 *
 * One model call per document, over REDACTED pages only. Each claim must carry a
 * quote that appears verbatim on the page it cites, after whitespace normalisation
 * and at most 25 words. A claim whose quote cannot be found is dropped, and the
 * document is retried once with the specific quotes that failed.
 *
 * The verbatim rule is the whole point. A model asked for "the revenue figure"
 * will happily produce a number that is approximately right, and approximately
 * right is exactly the failure this fund is paying to avoid — it is how a deck
 * claiming 31 paying firms and a form saying 24 both become "about 30" and the
 * contradiction disappears. Verification against the page is cheap and absolute.
 */

import { z } from 'zod';

import { callModel } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../gateway/guards';
import { quoteAppearsOnPage } from '../ingest/pdf';
import type { FounderIdentity } from '../redact';

export const ClaimSchema = z.object({
  metric: z.string().min(1),
  value_text: z.string().nullable(),
  value_num: z.number().nullable(),
  unit: z.enum(['INR', 'pct', 'count', 'months', 'x', 'other']).nullable(),
  period: z.string().nullable(),
  is_target: z.boolean(),
  quote: z.string().min(1),
  page: z.number().int().positive(),
});

export const ClaimsResponseSchema = z.object({ claims: z.array(ClaimSchema) });

export type ExtractedClaim = z.infer<typeof ClaimSchema>;

/** The JSON schema handed to the provider. Kept in sync with ClaimSchema by the test. */
export const CLAIMS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['metric', 'value_text', 'value_num', 'unit', 'period', 'is_target', 'quote', 'page'],
        properties: {
          metric: { type: 'string' },
          value_text: { type: ['string', 'null'] },
          value_num: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], enum: ['INR', 'pct', 'count', 'months', 'x', 'other', null] },
          period: { type: ['string', 'null'] },
          is_target: { type: 'boolean' },
          quote: { type: 'string' },
          page: { type: 'integer' },
        },
      },
    },
  },
} as const;

const SYSTEM = `You extract factual claims from one document of a startup's funding application.

Rules, in order of importance:
1. Every claim MUST include a quote copied character-for-character from the page it
   cites. Do not paraphrase, do not tidy, do not fix typos. Keep it under 25 words.
2. Cite the page number the quote came from.
3. A forward-looking statement is a target, not an actual. "In 12 months: 150 paying
   firms" is a target. Set is_target true for those.
4. Extract numbers that matter for judging a business: revenue, customers, growth,
   retention and repeat, unit economics, market size, team size, fundraising terms,
   and any figure the document presents as evidence.
5. If a figure appears with no number you can read, still record it with value_num
   null and the quote. A missing number is information.
6. Do not infer, combine or compute anything. Report only what the page says.

Founder names appear as [F1], [F2]. That is deliberate; do not speculate about them.

${DATA_NOT_INSTRUCTIONS}`;

export interface ExtractInput {
  applicationId: string;
  documentId: string;
  kind: 'deck' | 'form';
  company: string;
  /** Redacted page text, index 0 being page 1. */
  redactedPages: string[];
  /** Normalised page text used for verbatim verification. */
  normalisedPages: string[];
  founders?: FounderIdentity[];
  traceId?: string;
}

export interface ExtractResult {
  claims: Array<ExtractedClaim & { quote_verified: true }>;
  /** Claims the model produced whose quote was not on the page. */
  rejected: Array<{ claim: ExtractedClaim; reason: string }>;
  attempts: number;
  costInr: number;
  model: string;
}

function buildUser(input: ExtractInput, failures: string[]): string {
  const pages = input.redactedPages
    .map((text, i) => `--- page ${i + 1} ---\n${text.trim()}`)
    .join('\n\n');

  const retryNote = failures.length
    ? `\n\nA previous attempt produced these quotes, none of which appear on the page ` +
      `they cited. Do not repeat them; copy text exactly as printed:\n` +
      failures.map((f) => `- ${f}`).join('\n')
    : '';

  return `Document: the ${input.kind} for ${input.company}.\n\n${pages}${retryNote}`;
}

/**
 * Verify a claim's quote against the page it cites.
 *
 * Returns the reason it failed, or null when it is good.
 */
export function verifyClaim(claim: ExtractedClaim, normalisedPages: string[]): string | null {
  const page = normalisedPages[claim.page - 1];
  if (page === undefined) return `cites page ${claim.page}, which this document does not have`;
  if (claim.quote.trim().split(/\s+/).length > 25) return 'quote is longer than 25 words';
  if (!quoteAppearsOnPage(claim.quote, page)) return `quote not found on page ${claim.page}`;
  return null;
}

/**
 * Extract and verify claims for one document.
 *
 * Retried once, because a model that invented a quote will often get it right when
 * told exactly which quote was wrong. A second failure drops the claim rather than
 * looping: an unverifiable claim is worth less than the time spent chasing it.
 */
export async function extractClaims(input: ExtractInput): Promise<ExtractResult> {
  let attempts = 0;
  let costInr = 0;
  let model = '';
  let failures: string[] = [];
  const verified: Array<ExtractedClaim & { quote_verified: true }> = [];
  const rejected: Array<{ claim: ExtractedClaim; reason: string }> = [];

  while (attempts < 2) {
    attempts += 1;

    const response = await callModel({
      step: `extract_claims:${input.kind}`,
      system: SYSTEM,
      user: buildUser(input, failures),
      temperature: 0,
      responseSchema: CLAIMS_JSON_SCHEMA,
      founders: input.founders,
      applicationId: input.applicationId,
      traceId: input.traceId,
    });

    costInr += response.costInr;
    model = response.model;

    const parsed = ClaimsResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      failures = ['the response was not valid JSON matching the required shape'];
      continue;
    }

    failures = [];
    for (const claim of parsed.data.claims) {
      const reason = verifyClaim(claim, input.normalisedPages);
      if (reason) {
        rejected.push({ claim, reason });
        failures.push(`"${claim.quote}" (${reason})`);
      } else {
        verified.push({ ...claim, quote_verified: true });
      }
    }

    // Good enough: most claims verified, or nothing left to fix by asking again.
    if (failures.length === 0 || verified.length > 0) break;
  }

  return { claims: verified, rejected, attempts, costInr, model };
}
