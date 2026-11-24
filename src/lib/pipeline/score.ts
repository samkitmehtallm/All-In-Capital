/**
 * Pipeline step 6 — score.
 *
 * One model call per criterion, with structured output citing the claim ids it
 * relied on. Six criteria, so six calls per application, each one narrow enough
 * that the model is answering a single question against named evidence rather than
 * forming an overall impression and justifying it afterwards.
 *
 * Three rules shape this and all three come from the fund's own record:
 *
 *   - **Uncited output above 2 is rejected** (brief §7.6). A score of 7 with no
 *     claim behind it is the thing Kushal said is "worse than useless": he would
 *     stop trusting it without being able to say when.
 *   - **A missing number scores 2 with low confidence and names the gap** (R4,
 *     Meeting 1: "a missing number should drag the score, not be skipped").
 *   - **The scorer sees retrieved memo passages, not every memo** (§2.3), plus any
 *     remembered correction for a similar company (§10).
 */

import { z } from 'zod';

import { getStore } from '../db/index';
import { callModel, embed } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS, MAX_RETRIEVED_PASSAGES } from '../gateway/guards';
import type { FounderIdentity } from '../redact';
import { CRITERIA, resolveWeights, type Criterion, type SectorLens } from '../rubric';
import type { ReconCheck } from './reconcile';

export const CriterionScoreSchema = z.object({
  score: z.number().min(0).max(10),
  confidence: z.enum(['high', 'med', 'low']),
  /** One sentence a founder would understand, no jargon, no citation codes. */
  plain: z.string().min(1),
  /** The one question to ask about this area. */
  ask: z.string().min(1),
  /** Claim ids this score rests on. */
  claim_ids: z.array(z.string()),
  /** What was missing, where something was. */
  gap: z.string().nullable(),
});

export type CriterionScoreOut = z.infer<typeof CriterionScoreSchema>;

export const CRITERION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'confidence', 'plain', 'ask', 'claim_ids', 'gap'],
  properties: {
    score: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'med', 'low'] },
    plain: { type: 'string' },
    ask: { type: 'string' },
    claim_ids: { type: 'array', items: { type: 'string' } },
    gap: { type: ['string', 'null'] },
  },
} as const;

/** Rating words. Numbers live in tooltips; the screen shows these (brief §13). */
export function ratingWord(score: number): 'Strong' | 'Promising' | 'Mixed' | 'Thin' {
  if (score >= 7.5) return 'Strong';
  if (score >= 6) return 'Promising';
  if (score >= 4) return 'Mixed';
  return 'Thin';
}

export interface ScoreEvidence {
  /** Claims, with the ids the model must cite. */
  claims: Array<{ id: string; metric: string; value_text: string | null; period: string | null; quote: string; page: number; source: 'deck' | 'form'; is_target: boolean }>;
  /** Reconciliation findings, so the scorer knows what did not add up. */
  checks: ReconCheck[];
  /** Redacted founder backgrounds ([F1], [F2]). */
  founderBackgrounds: string[];
}

export interface ScoreCriterionInput {
  applicationId: string;
  company: string;
  sector: string | null;
  lens: SectorLens;
  criterion: Criterion;
  evidence: ScoreEvidence;
  founders?: FounderIdentity[];
  traceId?: string;
  rubricVersion: number;
}

export interface ScoredCriterion extends CriterionScoreOut {
  criterionKey: Criterion['key'];
  ratingWord: ReturnType<typeof ratingWord>;
  /** True when the model's own output was rejected and the floor was applied. */
  flooredForMissingCitation: boolean;
  costInr: number;
  model: string;
}

function buildSystem(criterion: Criterion): string {
  const anchors = criterion.anchors
    .map((a) => `  ${a.score}/10 — ${a.text}\n       (${a.source})`)
    .join('\n');

  return `You score ONE criterion of a startup application for a pre-seed fund in India.

Criterion: ${criterion.name}
What it covers: ${criterion.covers}
The question it is really asking: ${criterion.question}

Anchors, drawn from the fund's own past decisions:
${anchors}

How to score:
- Cite the label of every claim your score rests on, in claim_ids, exactly as it
  appears in square brackets (for example "c03"). A score above 2 with no valid
  citation will be rejected.
- If the evidence for this criterion is missing, score 2, set confidence "low", and
  name what is missing in "gap". Do not skip it and do not score it generously.
- Confidence: "high" only if something outside the application corroborates it,
  "med" if the deck and form agree, "low" if only the deck says it or the two
  contradict each other.
- Pedigree alone is not evidence. A named employer or school with nothing shown for
  it scores 0 on founder-market fit.
- "plain" is one sentence a founder would understand. No jargon, no scores, no
  citation codes, no em dashes.
- "ask" is the single question you would put to them about this area.

Founder names appear as [F1], [F2]. That is deliberate.

${DATA_NOT_INSTRUCTIONS}`;
}

/**
 * Retrieve the memo passages most like this application.
 *
 * Top ${MAX_RETRIEVED_PASSAGES} only. The guard throws above that, which is the
 * point: handing the scorer all forty-eight passages would send the fund's entire
 * decision history to a third party on every one of sixty calls.
 */
async function retrieveMemoPassages(subject: string, criterion: Criterion): Promise<string[]> {
  const store = await getStore();
  const [vector] = await embed([`${criterion.name}. ${criterion.covers}. ${subject}`], {
    step: 'retrieve_memos',
  });

  const hits = await store.nearest<{ redacted_text: string; section: string }>({
    table: 'memo_passages',
    column: 'embedding',
    embedding: vector,
    limit: MAX_RETRIEVED_PASSAGES,
  });

  return hits.map((h) => h.row.redacted_text).filter(Boolean);
}

/** Past decisions that went against the recommendation, for similar companies (§10). */
async function retrieveCorrections(subject: string): Promise<string[]> {
  const store = await getStore();
  const count = await store.count('corrections');
  if (count === 0) return [];

  const [vector] = await embed([subject], { step: 'retrieve_corrections' });
  const hits = await store.nearest<{ recommended: string; decided: string; note: string | null; redacted_text: string }>({
    table: 'corrections',
    column: 'embedding',
    embedding: vector,
    limit: 3,
  });

  return hits
    .filter((h) => h.similarity > 0.6)
    .map(
      (h) =>
        `On a similar company the system recommended "${h.row.recommended}" and Riya decided ` +
        `"${h.row.decided}"${h.row.note ? `: ${h.row.note}` : '.'}`,
    );
}

/**
 * Short, prompt-local labels for claims: c01, c02, ...
 *
 * Database UUIDs are never put in a prompt, for two reasons. The first is a real
 * bug this caused: a UUID's final group is 12 hex characters, and when they happen
 * to be all digits it matches the phone-number pattern exactly, so the send-less
 * guard throws on roughly one run in three. The second is that a 36-character
 * identifier is both something for a model to mistype and 3KB of wasted prompt
 * across eighty claims, repeated for all six criteria.
 *
 * The labels are mapped back to real ids after the call, and an id the model
 * invents simply fails that lookup.
 */
function labelClaims(claims: ScoreEvidence['claims']): {
  lines: string;
  toId: Map<string, string>;
} {
  const toId = new Map<string, string>();
  const lines = claims
    .map((c, i) => {
      const label = `c${String(i + 1).padStart(2, '0')}`;
      toId.set(label, c.id);
      return (
        `[${label}] (${c.source} p${c.page})${c.is_target ? ' TARGET' : ''} ${c.metric}: ` +
        `${c.value_text ?? 'no number given'}${c.period ? ` (${c.period})` : ''} — "${c.quote}"`
      );
    })
    .join('\n');
  return { lines, toId };
}

function buildUser(
  input: ScoreCriterionInput,
  memos: string[],
  corrections: string[],
  claimLines: string,
): string {
  const { evidence } = input;

  const claims = evidence.claims.length ? claimLines : '(no claims were extracted from this application)';

  const checks = evidence.checks.length
    ? evidence.checks
        .filter((c) => c.severity !== 'info')
        .map((c) => `- [${c.severity}] ${c.title}: ${c.plain}`)
        .join('\n') || '(nothing failed to reconcile)'
    : '(no reconciliation was run)';

  const sections = [
    `Company: ${input.company}${input.sector ? ` (${input.sector})` : ''}`,
    `\nFounders, as the form describes them:\n${evidence.founderBackgrounds.join('\n') || '(not stated)'}`,
    `\nClaims extracted from the application, with ids to cite:\n${claims}`,
    `\nWhat did not reconcile:\n${checks}`,
  ];

  if (memos.length) {
    sections.push(
      `\nHow this fund has reasoned on similar files before (names removed):\n` +
        memos.map((m) => `- ${m}`).join('\n'),
    );
  }

  if (corrections.length) {
    sections.push(`\nCorrections worth remembering:\n${corrections.map((c) => `- ${c}`).join('\n')}`);
  }

  return sections.join('\n');
}

/**
 * Score one criterion.
 *
 * An uncited score above 2 is not retried — it is floored to 2 with low confidence
 * and the gap named. Retrying invites the model to invent a citation, which is a
 * worse outcome than an honest "there is nothing here to score".
 */
export async function scoreCriterion(input: ScoreCriterionInput): Promise<ScoredCriterion> {
  const subject = `${input.company}. ${input.evidence.founderBackgrounds.join(' ')}`;
  const [memos, corrections] = await Promise.all([
    retrieveMemoPassages(subject, input.criterion),
    retrieveCorrections(subject),
  ]);

  const { lines: claimLines, toId } = labelClaims(input.evidence.claims);

  const response = await callModel({
    step: `score:${input.criterion.key}`,
    system: buildSystem(input.criterion),
    user: buildUser(input, memos, corrections, claimLines),
    temperature: 0.1,
    responseSchema: CRITERION_JSON_SCHEMA,
    founders: input.founders,
    retrievedPassages: memos,
    applicationId: input.applicationId,
    traceId: input.traceId,
  });

  const parsed = CriterionScoreSchema.safeParse(response.json);

  if (!parsed.success) {
    return {
      criterionKey: input.criterion.key,
      score: 2,
      confidence: 'low',
      plain: 'This area could not be assessed from what the application provides.',
      ask: input.criterion.question,
      claim_ids: [],
      gap: 'The scorer did not return a usable answer for this area.',
      ratingWord: ratingWord(2),
      flooredForMissingCitation: true,
      costInr: response.costInr,
      model: response.model,
    };
  }

  const out = parsed.data;

  // Map the prompt-local labels back to real ids. A label the model invented is
  // not in the map, so it is not a citation.
  const valid = out.claim_ids
    .map((label) => toId.get(label.trim()))
    .filter((id): id is string => id !== undefined);

  if (out.score > 2 && valid.length === 0) {
    return {
      ...out,
      criterionKey: input.criterion.key,
      score: 2,
      confidence: 'low',
      claim_ids: [],
      gap:
        out.gap ??
        'Scored without pointing at anything in the application, so it is treated as unevidenced.',
      ratingWord: ratingWord(2),
      flooredForMissingCitation: true,
      costInr: response.costInr,
      model: response.model,
    };
  }

  return {
    ...out,
    criterionKey: input.criterion.key,
    claim_ids: valid,
    ratingWord: ratingWord(out.score),
    flooredForMissingCitation: false,
    costInr: response.costInr,
    model: response.model,
  };
}

export interface ScoreAllResult {
  scores: ScoredCriterion[];
  weightedScore: number;
  weights: Record<Criterion['key'], number>;
  costInr: number;
}

/** Score all six criteria and combine them with the resolved weights. */
export async function scoreApplication(
  base: Omit<ScoreCriterionInput, 'criterion'>,
  view: 'revealed' | 'written' = 'revealed',
): Promise<ScoreAllResult> {
  const { weights } = resolveWeights(view, view === 'written' ? 'none' : base.lens);

  // Sequential, not parallel: six calls at once for ten applications is sixty
  // concurrent requests, which is how the 429s and the retry storm start. The
  // queue exists to spread load, and the scorer should not fight it.
  const scores: ScoredCriterion[] = [];
  for (const criterion of CRITERIA) {
    scores.push(await scoreCriterion({ ...base, criterion }));
  }

  const weightedScore = scores.reduce((sum, s) => sum + s.score * weights[s.criterionKey], 0);

  return {
    scores,
    weightedScore: Math.round(weightedScore * 100) / 100,
    weights,
    costInr: scores.reduce((a, s) => a + s.costInr, 0),
  };
}
