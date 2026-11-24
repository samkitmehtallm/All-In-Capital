/**
 * Pipeline step 7 — recommend, lane, bucket, rank. Pure code.
 *
 * The thresholds live in versioned config; this file only applies them. Two of the
 * rules are easy to get subtly wrong and are worth stating:
 *
 *   - "Take the call" needs more than a score. It needs no gate tripped AND
 *     confidence of med or better on C1, C2 and C3 (brief §6). A 7.6 built on
 *     three low-confidence guesses is not a call, it is a coin toss with a
 *     decimal point.
 *   - A tripped gate changes the LANE, not the score. The application still has
 *     whatever score the evidence supports; Riya decides what to do about the gate.
 */

import { THRESHOLDS, type Criterion } from '../rubric';
import { ratingWord } from './score';

export type Lane = 'worth_a_call' | 'check_first' | 'dig_first' | 'not_now';
export type Recommendation = 'take_call' | 'dig_first' | 'pass';
export type Bucket = 'clear' | 'flagged' | 'outside_mandate';

export interface RankInput {
  applicationId: string;
  weightedScore: number;
  /** Confidence per criterion, needed for the C1-C3 condition. */
  confidence: Record<Criterion['key'], 'high' | 'med' | 'low'>;
  /** Any gate that tripped, by key. */
  trippedGates: string[];
  /** Share of criteria whose score rests on at least one real claim, 0 to 1. */
  evidenceCoverage: number;
  /** The sector the pipeline resolved, for the outside-mandate bucket. */
  sectorResolved: string | null;
  receivedAt: string;
}

export interface RankOutput {
  recommendation: Recommendation;
  lane: Lane;
  bucket: Bucket;
  ratingWord: ReturnType<typeof ratingWord>;
  /** Why this recommendation and not the next one up. One sentence. */
  because: string;
}

/** Sectors the written thesis puts outside the mandate (brief §5). */
const OUTSIDE = ['healthcare', 'web3', 'crypto', 'real estate'];

function isOutsideMandate(sector: string | null): boolean {
  if (!sector) return false;
  const s = sector.toLowerCase();
  return OUTSIDE.some((o) => s.includes(o));
}

const CORE: Array<Criterion['key']> = ['c1', 'c2', 'c3'];

export function rankOne(input: RankInput): RankOutput {
  const outside = isOutsideMandate(input.sectorResolved);
  const gated = input.trippedGates.length > 0;

  const coreConfident = CORE.every((k) => input.confidence[k] === 'high' || input.confidence[k] === 'med');
  const lowCore = CORE.filter((k) => input.confidence[k] === 'low');

  let recommendation: Recommendation;
  let because: string;

  if (input.weightedScore >= THRESHOLDS.takeCall && !gated && coreConfident) {
    recommendation = 'take_call';
    because = 'Scores well across the areas that matter most, with nothing unresolved.';
  } else if (input.weightedScore >= THRESHOLDS.digFirst) {
    recommendation = 'dig_first';
    because =
      input.weightedScore >= THRESHOLDS.takeCall && !coreConfident
        ? `Scores high enough for a call, but we are not confident on ${lowCore.length === 1 ? 'one of the core areas' : 'several core areas'} yet.`
        : 'Close, with specific questions that would settle it.';
  } else {
    recommendation = 'pass';
    because = 'Not enough here yet, and the gaps are the kind that take time to close.';
  }

  // A tripped gate overrides the lane but never the score or the recommendation.
  // Riya still sees what the evidence said; the lane only changes reading order.
  const lane: Lane = gated
    ? 'check_first'
    : recommendation === 'take_call'
      ? 'worth_a_call'
      : recommendation === 'dig_first'
        ? 'dig_first'
        : 'not_now';

  const bucket: Bucket = outside ? 'outside_mandate' : gated ? 'flagged' : 'clear';

  return { recommendation, lane, bucket, ratingWord: ratingWord(input.weightedScore), because };
}

const BUCKET_ORDER: Record<Bucket, number> = { clear: 0, flagged: 1, outside_mandate: 2 };

/**
 * Order the board: bucket, then score, then evidence coverage, then oldest first.
 *
 * Oldest-first last is deliberate. Two applications that are otherwise equal should
 * not have their order decided by which was uploaded most recently, or a founder who
 * applied in week one waits behind week four forever.
 */
export function rankAll<T extends RankInput & RankOutput>(items: T[]): Array<T & { rank: number }> {
  const sorted = [...items].sort((a, b) => {
    const bucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bucket !== 0) return bucket;
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.evidenceCoverage !== a.evidenceCoverage) return b.evidenceCoverage - a.evidenceCoverage;
    return a.receivedAt.localeCompare(b.receivedAt);
  });

  return sorted.map((item, i) => ({ ...item, rank: i + 1 }));
}

/**
 * Share of criteria that rest on at least one real claim.
 *
 * This is what separates "scored 6.2" from "scored 6.2 on two of six areas with
 * anything behind them", and it is the tie-breaker above date for exactly that
 * reason.
 */
export function evidenceCoverage(scores: Array<{ claim_ids: string[] }>): number {
  if (scores.length === 0) return 0;
  const cited = scores.filter((s) => s.claim_ids.length > 0).length;
  return Math.round((cited / scores.length) * 100) / 100;
}
