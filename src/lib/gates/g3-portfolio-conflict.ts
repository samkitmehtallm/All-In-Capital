/**
 * Gate G3 — portfolio conflict.
 *
 * Meeting 4: an inbound meeting-notes startup overlapped MeetRecord, and it was
 * only caught "because Riya happens to know the portfolio". Kushal: "I would rather
 * get a flag on a false alarm than miss a real conflict." So this gate always
 * reports its best match; it does not decide whether a conflict exists.
 *
 * ## Why this does not use a similarity threshold
 *
 * Measured against the real portfolio with real Gemini vectors, every one of the
 * ten applications scores between 0.50 and 0.75 cosine against *something*. An
 * absolute cut at 0.55 flags nine of ten, including Settlr (SME payments) against
 * NewMe (fast fashion) at 0.630. The embedding space simply has a high floor:
 * two unrelated Indian startup one-liners are still both Indian startup one-liners.
 *
 * What separates a real overlap is the MARGIN between the top match and the rest
 * of the portfolio for that same applicant:
 *
 *   Talkbook   -> MeetRecord 0.720, next 0.598   margin 0.122, z 3.24  real
 *   StockSathi -> SuperK     0.745, next 0.662   margin 0.083, z 2.70  real
 *   CareCorner -> SuperK     0.631, next 0.584   margin 0.047, z 2.20  noise
 *   Settlr     -> NewMe      0.630, next 0.620   margin 0.010, z 1.89  noise
 *
 * Measured against the real portfolio on 24 Nov 2026 with gemini-embedding-001.
 *
 * So the score is a z-score against the applicant's own distribution across the
 * whole portfolio, which normalises the floor away. Flagging still happens either
 * way — strength only changes how it is described and ordered.
 */

import { cosine, type Store } from '../db/store';
import type { GateCitation, GateResult } from './g1-stage-cheque';

/**
 * How far above its own mean a match has to sit to read as a real overlap.
 *
 * Chosen, not derived. On the ten applications in this dataset the two known
 * conflicts land at z 3.24 (Talkbook/MeetRecord) and 2.70 (StockSathi/SuperK),
 * and the next candidate sits at 2.20 — so any value between 2.21 and 2.69
 * separates them perfectly, and 2.5 is the middle of that gap.
 *
 * That is a margin one sample wide, on a sample of ten with two positives. It is
 * a judgement call, not a validated threshold, and it will move once there are
 * more labelled conflicts. Nothing is hidden by getting it wrong: everything
 * above WEAK_Z is still reported to Riya, and the wording is all that changes.
 *
 * One property of a z-score matters here: with N portfolio rows, the largest z
 * any match can reach is sqrt(N - 1). At 22 rows the ceiling is 4.58, so 3.24 is
 * comfortably inside it — but a portfolio under 8 companies could never produce a
 * z of 2.5 at all, and this gate would silently never report a strong overlap.
 * `strongBandReachable()` says whether the threshold is even attainable, so that
 * failure mode is visible rather than looking like "no conflicts found".
 */
export const STRONG_Z = 2.5;
/** Below this it is reported, but described as worth a glance rather than an overlap. */
export const WEAK_Z = 1.2;

/**
 * Can a strong overlap even be detected against a portfolio of this size?
 *
 * The maximum z for N rows is sqrt(N - 1). Below that, every match is capped into
 * the "worth a glance" band regardless of how obvious the overlap is.
 */
export function strongBandReachable(portfolioSize: number): boolean {
  return Math.sqrt(Math.max(portfolioSize - 1, 0)) >= STRONG_Z;
}

export interface PortfolioMatch {
  name: string;
  oneLiner: string | null;
  similarity: number;
  /** Standard deviations above this applicant's mean similarity. */
  z: number;
  sourceUrl: string | null;
  sourceNote: string | null;
}

export interface G3Result extends Omit<GateResult, 'gateKey'> {
  gateKey: 'g3_conflict';
  /** True when the closest match is worth showing but not a conflict. */
  worthAGlance: boolean;
  matches: PortfolioMatch[];
  /**
   * Portfolio rows with no description, matched on their name alone. The gate's
   * coverage over these is weak, and the Portfolio screen says so.
   */
  unmatchableCount: number;
}

interface PortfolioRow {
  [key: string]: unknown;
  name: string;
  one_liner: string | null;
  embedding: number[] | string | null;
  source_url: string | null;
  source_note: string | null;
}

function toVector(value: number[] | string | null): number[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as number[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Compare one applicant against every portfolio company.
 *
 * `subject` should be the applicant's one-liner and product description, already
 * embedded by the gateway — this function does no model calls of its own, so it
 * stays a pure, testable function over vectors.
 */
export async function evaluateG3(
  store: Store,
  subject: number[],
  opts: { topN?: number } = {},
): Promise<G3Result> {
  const rows = await store.select<PortfolioRow>('portfolio_companies');

  const scored = rows
    .map((row) => {
      const vec = toVector(row.embedding);
      if (!vec) return null;
      return {
        name: row.name,
        oneLiner: row.one_liner,
        similarity: cosine(subject, vec),
        z: 0,
        sourceUrl: row.source_url,
        sourceNote: row.source_note,
      } satisfies PortfolioMatch;
    })
    .filter((m): m is PortfolioMatch => m !== null);

  // Rows the gate can see only weakly.
  //
  // The seed embeds name + one-liner + tags, so a row with no description still
  // gets a vector — from its name alone. That is a much thinner signal than a
  // description, and counting only vector-less rows would report full coverage
  // while six of the twenty-two are effectively being matched on a word. This
  // counts what is actually weak, which is the honest version of "always flag":
  // the gate can only promise coverage of what it can read.
  const unmatchableCount = rows.filter((r) => !r.one_liner).length;

  if (scored.length === 0) {
    return {
      gateKey: 'g3_conflict',
      tripped: false,
      plainName: 'No portfolio to check against',
      reason: 'The portfolio has no company descriptions to compare this against.',
      citations: [],
      decidedBy: 'code',
      worthAGlance: false,
      matches: [],
      unmatchableCount,
    };
  }

  const mean = scored.reduce((a, m) => a + m.similarity, 0) / scored.length;
  const variance = scored.reduce((a, m) => a + (m.similarity - mean) ** 2, 0) / scored.length;
  const sd = Math.sqrt(variance) || 1e-9;
  for (const m of scored) m.z = (m.similarity - mean) / sd;

  scored.sort((a, b) => b.z - a.z);
  const matches = scored.slice(0, opts.topN ?? 3);
  const top = matches[0];

  const citations: GateCitation[] = top
    ? [
        {
          kind: 'portfolio',
          ref: top.name,
          quote: top.oneLiner ?? top.name,
        },
      ]
    : [];

  // Only a strong overlap moves the lane.
  //
  // The first full run put all ten applications in "Check first" because every one
  // of them has SOME nearest neighbour above the weak band, and a board with one
  // lane holding everything is no board at all. "A false alarm beats a missed
  // conflict" means Riya must SEE the flag, not that every application is routed to
  // her: the weak band is still reported on the application and still shows the
  // closest company, it just does not claim a conflict exists.
  const strong = top.z >= STRONG_Z;
  const worthAGlance = top.z >= WEAK_Z;

  return {
    gateKey: 'g3_conflict',
    tripped: strong,
    plainName: strong ? `Overlaps ${top.name}` : `Looks close to ${top.name}`,
    reason: strong
      ? `This does much the same thing as ${top.name}, which is already in the portfolio. ` +
        `Nothing in the application mentions it.`
      : `The closest company in the portfolio is ${top.name}. The overlap is not obvious, ` +
        `so this is worth a glance rather than a conflict.`,
    citations,
    decidedBy: 'code',
    worthAGlance,
    matches,
    unmatchableCount,
  };
}
