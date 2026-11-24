/**
 * Calibration — score the twelve memos blind and compare with what the fund did.
 *
 * This is the answer to "I'm not switching off Riya's triage because a demo went
 * well. Run it against those and tell me how often it disagrees with us."
 *
 * What blind means here, precisely:
 *   - The scorer sees "What it does", "Founder assessment" and "Risks and open
 *     questions", with the company and founder names removed.
 *   - It never sees the decision, the stage label, or "Why we invested/passed".
 *     The stage label is withheld too because "Early round" against "Pre-seed"
 *     correlates with the outcome in this pack and would leak it.
 *
 * Two honest limits, both reported rather than buried:
 *   - It is IN-SAMPLE. The rubric was reconstructed from these same twelve memos,
 *     so agreement here is close to the best case and is not evidence of accuracy
 *     on a new application.
 *   - The citation rule cannot apply. A memo has no extracted claims to cite, so
 *     the "uncited output above 2 is rejected" guard is inert on this path. That
 *     makes memo scores slightly more generous than application scores, which is
 *     a reason not to compare the two numbers directly.
 */

import { z } from 'zod';

import { callModel } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../gateway/guards';
import { redact } from '../redact';
import { CRITERIA, resolveWeights, THRESHOLDS, lensForSector } from '../rubric';
import { ratingWord } from './score';

export interface MemoRecord {
  id: string;
  ordinal: number;
  company: string;
  sector: string | null;
  decision: 'INVESTED' | 'PASSED';
  whatItDoes: string;
  founderAssessment: string;
  risks: string;
  why: string;
}

/**
 * Teaching pairs, from the memo pack itself.
 *
 * Each pairs a company the fund backed with one it passed in the same category, so
 * "did the backed company outscore the passed one?" is a question about judgement
 * rather than about sector preference. All twelve memos appear exactly once.
 */
export const TEACHING_PAIRS: Array<{ invested: string; passed: string; about: string }> = [
  { invested: 'Giva', passed: 'Petalry', about: 'consumer brand, on cohort repeat' },
  { invested: 'Jai Kisan', passed: 'CampusCredit', about: 'lending, on who owns the risk' },
  { invested: 'The ePlane Company', passed: 'AeroDrop', about: 'deeptech, on a milestone path' },
  { invested: 'Wint Wealth', passed: 'Coinlane', about: 'fintech, on regulatory dependence' },
  { invested: 'SuperK', passed: 'HopBox', about: 'commerce, on structure at pre-seed' },
  { invested: 'Unbox Robotics', passed: 'Prepnest', about: 'defensibility beyond one person' },
];

const BlindScoreSchema = z.object({
  scores: z.array(
    z.object({
      criterion: z.enum(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']),
      score: z.number().min(0).max(10),
      confidence: z.enum(['high', 'med', 'low']),
    }),
  ),
});

const BLIND_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'score', 'confidence'],
        properties: {
          criterion: { type: 'string', enum: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
          score: { type: 'number' },
          confidence: { type: 'string', enum: ['high', 'med', 'low'] },
        },
      },
    },
  },
} as const;

function blindSystem(): string {
  const criteria = CRITERIA.map(
    (c) =>
      `${c.key}. ${c.name} — ${c.covers}\n   Asking: ${c.question}\n   ` +
      c.anchors.map((a) => `${a.score}: ${a.text}`).join('\n   '),
  ).join('\n\n');

  return `You score a company against six criteria for a pre-seed fund in India.

You are given only a description of what the company does, an assessment of its
founders, and its risks. You are NOT told what the fund decided, and you must not
guess at it or let a guess shape the scores. Score what the text supports.

${criteria}

Score every criterion. Where the text says nothing about a criterion, score 2 with
low confidence rather than assuming the best or the worst.

${DATA_NOT_INSTRUCTIONS}`;
}

/**
 * The memo as the scorer is allowed to see it.
 *
 * Exported so the test can assert that the outcome never appears in it. A blind
 * test that silently stops being blind is worse than no blind test.
 */
export function blindText(memo: MemoRecord): string {
  const body = [
    `What it does. ${memo.whatItDoes}`,
    `Founder assessment. ${memo.founderAssessment}`,
    `Risks and open questions. ${memo.risks}`,
  ].join('\n\n');

  // The company's own name is removed as well as the founders'. Leaving it in
  // would let a model that recognises the company recall the real outcome.
  const withoutCompany = body.replace(new RegExp(memo.company, 'gi'), 'the company');
  return redact(withoutCompany, []).text;
}

export interface BlindResult {
  memoId: string;
  company: string;
  fundDecision: 'INVESTED' | 'PASSED';
  weightedScore: number;
  ratingWord: string;
  systemCall: 'take_call' | 'dig_first' | 'pass';
  /** Would the system have carried it forward at all? */
  systemAdvances: boolean;
  fundAdvanced: boolean;
  agreed: boolean;
  costInr: number;
}

export async function scoreMemoBlind(memo: MemoRecord): Promise<BlindResult> {
  const response = await callModel({
    step: 'calibration:blind_score',
    system: blindSystem(),
    user: blindText(memo),
    temperature: 0,
    responseSchema: BLIND_JSON_SCHEMA,
  });

  const parsed = BlindScoreSchema.safeParse(response.json);
  const { weights } = resolveWeights('revealed', lensForSector(memo.sector));

  let weightedScore = 0;
  if (parsed.success) {
    for (const row of parsed.data.scores) {
      weightedScore += row.score * (weights[row.criterion] ?? 0);
    }
  }
  weightedScore = Math.round(weightedScore * 100) / 100;

  const systemCall =
    weightedScore >= THRESHOLDS.takeCall
      ? 'take_call'
      : weightedScore >= THRESHOLDS.digFirst
        ? 'dig_first'
        : 'pass';

  // "Advance" is take_call OR dig_first: both mean the fund keeps spending time on
  // it, which is the decision being compared. Treating dig_first as a pass would
  // score the system as agreeing with every rejection it was merely unsure about.
  const systemAdvances = systemCall !== 'pass';
  const fundAdvanced = memo.decision === 'INVESTED';

  return {
    memoId: memo.id,
    company: memo.company,
    fundDecision: memo.decision,
    weightedScore,
    ratingWord: ratingWord(weightedScore),
    systemCall,
    systemAdvances,
    fundAdvanced,
    agreed: systemAdvances === fundAdvanced,
    costInr: response.costInr,
  };
}

// ---------------------------------------------------------------------------
// Where we disagree
// ---------------------------------------------------------------------------

const DisagreementSchema = z.object({
  case_for: z.string().min(1),
  case_against: z.string().min(1),
  sources: z.array(z.string()),
});

const DISAGREEMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['case_for', 'case_against', 'sources'],
  properties: {
    case_for: { type: 'string' },
    case_against: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface Disagreement {
  caseFor: string;
  caseAgainst: string;
  sources: string[];
}

/**
 * The strongest case each way, in one plain sentence of at most twenty words.
 *
 * No citation tags in the sentences themselves (brief §10): the sources go in their
 * own field. A partner reading "Strong field work [m09 p3]" reads the tag, not the
 * argument. Over-length sentences are trimmed here rather than retried, because the
 * argument is usually right even when the word count is not.
 */
export async function explainDisagreement(
  memo: MemoRecord,
  result: BlindResult,
): Promise<Disagreement & { costInr: number }> {
  const response = await callModel({
    step: 'calibration:disagreement',
    system:
      `Two readers disagree about one company. Put the strongest case each way.\n\n` +
      `Rules:\n` +
      `- case_for argues for carrying the company forward.\n` +
      `- case_against argues for passing.\n` +
      `- Each is ONE sentence of at most 20 words, in plain words.\n` +
      `- Put no references, codes or brackets in either sentence. List what you drew ` +
      `on in "sources" instead.\n\n${DATA_NOT_INSTRUCTIONS}`,
    user:
      `${blindText(memo)}\n\n` +
      `One reader would ${result.systemAdvances ? 'carry it forward' : 'pass'}; ` +
      `the other would ${result.fundAdvanced ? 'carry it forward' : 'pass'}.`,
    temperature: 0.2,
    responseSchema: DISAGREEMENT_JSON_SCHEMA,
  });

  const parsed = DisagreementSchema.safeParse(response.json);
  if (!parsed.success) {
    return {
      caseFor: 'Could not be summarised.',
      caseAgainst: 'Could not be summarised.',
      sources: [],
      costInr: response.costInr,
    };
  }

  const trim = (s: string) => {
    const words = s.trim().split(/\s+/);
    // Strip any bracketed reference that slipped into the sentence anyway.
    const clean = words.join(' ').replace(/\s*[\[(][^\])]*[\])]/g, '');
    const out = clean.split(/\s+/);
    return out.length <= 20 ? clean : `${out.slice(0, 20).join(' ')}…`;
  };

  return {
    caseFor: trim(parsed.data.case_for),
    caseAgainst: trim(parsed.data.case_against),
    sources: parsed.data.sources,
    costInr: response.costInr,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ConfusionMatrix {
  /** Fund advanced, system advanced. */
  bothAdvance: number;
  /** Fund advanced, system passed — the expensive error: a missed company. */
  missed: number;
  /** Fund passed, system advanced — wasted time, the cheaper error. */
  falseAlarm: number;
  bothPass: number;
}

export function confusion(results: BlindResult[]): ConfusionMatrix {
  return {
    bothAdvance: results.filter((r) => r.fundAdvanced && r.systemAdvances).length,
    missed: results.filter((r) => r.fundAdvanced && !r.systemAdvances).length,
    falseAlarm: results.filter((r) => !r.fundAdvanced && r.systemAdvances).length,
    bothPass: results.filter((r) => !r.fundAdvanced && !r.systemAdvances).length,
  };
}

export interface PairResult {
  about: string;
  invested: string;
  passed: string;
  investedScore: number | null;
  passedScore: number | null;
  /** Did the company the fund backed score above the one it passed? */
  correct: boolean | null;
}

/**
 * Ranking agreement.
 *
 * Stricter and more useful than the confusion matrix: a system can agree on both
 * sides of a pair by chance, but ordering the backed company above the passed one
 * requires the rubric to have captured the distinction the partners actually drew.
 */
export function pairAgreement(results: BlindResult[]): PairResult[] {
  const byCompany = new Map(results.map((r) => [r.company, r.weightedScore]));
  return TEACHING_PAIRS.map((pair) => {
    const investedScore = byCompany.get(pair.invested) ?? null;
    const passedScore = byCompany.get(pair.passed) ?? null;
    return {
      about: pair.about,
      invested: pair.invested,
      passed: pair.passed,
      investedScore,
      passedScore,
      correct:
        investedScore === null || passedScore === null ? null : investedScore > passedScore,
    };
  });
}
