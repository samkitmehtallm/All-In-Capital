import 'server-only';

/**
 * Data for one application screen.
 *
 * Every sentence on this screen is DERIVED, not generated. "Our take", "For it",
 * "Against it" and "What would change our mind" all come from the criterion scores
 * the pipeline already produced and stored, and "Reminds us of" is the nearest memo
 * by vector. That costs nothing per page view, stays identical on reload, and — the
 * reason that matters — every sentence is traceable to a score and a claim rather
 * than to a summarising call that could quietly disagree with the numbers beside it.
 */

import { getStore } from './db/index';
import { CRITERIA, type Criterion } from './rubric';
import { formatINR } from './units';

export interface AreaRow {
  key: Criterion['key'];
  name: string;
  score: number;
  ratingWord: string;
  confidence: 'high' | 'med' | 'low';
  plain: string;
  ask: string | null;
  gap: string | null;
  citedClaims: number;
}

export interface GateRow {
  key: string;
  plainName: string;
  reason: string;
  tripped: boolean;
  decidedBy: string;
}

export interface CheckRow {
  key: string;
  title: string;
  severity: 'red' | 'warn' | 'info';
  formula: string | null;
  expected: string | null;
  found: string | null;
  plain: string;
}

export interface FounderRow {
  token: string;
  role: string | null;
  /**
   * The founder's background as the form states it, names included.
   *
   * The send-less rule governs what reaches a MODEL, not what reaches Riya. She is
   * screening a person and about to write to them, so showing her [F1] would be
   * privacy theatre that makes the tool unusable. The token is what the gateway
   * sees; this is what she sees.
   */
  background: string;
}

export interface ApplicationView {
  slug: string;
  company: string;
  oneLiner: string | null;
  sector: string | null;
  stage: string | null;
  location: string | null;
  raiseDisplay: string;
  postMoneyDisplay: string;
  deckPages: number;
  formPages: number;

  scored: boolean;
  ratingWord: string;
  /** 0 to 5, for the segmented meter. Never shown as a number. */
  segments: number;
  lane: string | null;
  recommendation: string | null;

  ourTake: string;
  forIt: string | null;
  againstIt: string | null;
  wouldChangeOurMind: string | null;
  remindsUsOf: { company: string; decision: string; why: string } | null;

  gates: GateRow[];
  areas: AreaRow[];
  checks: CheckRow[];
  founders: FounderRow[];
  claimCount: number;
}

const RECOMMENDATION_WORDS: Record<string, string> = {
  take_call: 'Worth a call',
  dig_first: 'Dig first',
  pass: 'Not now',
};

/** Rating word to filled segments. Five segments, four words (brief §13). */
function segmentsFor(word: string): number {
  return { Strong: 5, Promising: 4, Mixed: 3, Thin: 2 }[word] ?? 1;
}

/**
 * "Strongest on customer pull; thinnest on why now."
 *
 * The brief's exact target shape, built from the highest and lowest scoring areas.
 * Where everything scores the same there is no "strongest", and saying so beats
 * inventing a distinction the numbers do not support.
 */
function buildOurTake(areas: AreaRow[], recommendation: string | null): string {
  if (areas.length === 0) return 'Not scored yet.';

  const sorted = [...areas].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const verdict = recommendation ? RECOMMENDATION_WORDS[recommendation] ?? '' : '';

  if (best.score === worst.score) {
    return `${verdict ? `${verdict}. ` : ''}Scores evenly across every area, with nothing standing out either way.`;
  }

  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  return `${verdict ? `${verdict}. ` : ''}Strongest on ${lower(best.name)}; thinnest on ${lower(worst.name)}.`;
}

/**
 * What would change our mind.
 *
 * The question attached to the weakest area, plus any gap the scorer named. This is
 * the brief's "say what would change our view" on a pass, and it is deliberately
 * built from the lowest score rather than summarised: the thing most likely to move
 * the verdict is the thing currently dragging it.
 */
function buildWouldChange(areas: AreaRow[]): string | null {
  if (areas.length === 0) return null;
  const worst = [...areas].sort((a, b) => a.score - b.score)[0];
  const gaps = areas.filter((a) => a.gap).map((a) => a.gap!);

  const parts: string[] = [];
  if (worst.ask) parts.push(worst.ask);
  if (gaps.length > 0) {
    parts.push(
      gaps.length === 1
        ? `It would also help to close one gap: ${gaps[0].replace(/\.$/, '')}.`
        : `There are ${gaps.length} named gaps to close as well.`,
    );
  }
  return parts.length ? parts.join(' ') : null;
}

export async function getApplication(slug: string): Promise<ApplicationView | null> {
  const store = await getStore();

  const app = await store.selectOne<{
    id: string;
    slug: string;
    company_name: string;
    one_liner: string | null;
    sector_declared: string | null;
    stage_declared: string | null;
    location: string | null;
    raise_inr: number | null;
    post_money_text: string | null;
  }>('applications', { slug });
  if (!app) return null;

  const [documents, founderRows, scoreRows, gateRows, checkRows, assessment, claimCount] =
    await Promise.all([
      store.select<{ kind: string; page_count: number }>('documents', { application_id: app.id }),
      store.select<{ token: string; role: string | null; background_form: string }>('founders', {
        application_id: app.id,
      }),
      store.select<{
        criterion_key: string;
        score: number;
        confidence: string;
        rating_word: string;
        plain: string;
        ask: string | null;
        gap_named: string | null;
        claim_ids: string[] | null;
      }>('criterion_scores', { application_id: app.id, view: 'revealed' }),
      store.select<{
        gate_key: string;
        tripped: boolean;
        plain_name: string;
        reason: string;
        decided_by: string;
      }>('gate_results', { application_id: app.id }),
      store.select<{
        check_key: string;
        title: string;
        severity: string;
        formula: string | null;
        expected: string | null;
        found: string | null;
        plain: string;
      }>('recon_checks', { application_id: app.id }),
      store.selectOne<{
        rating_word: string;
        lane: string;
        recommendation: string;
        headline: string;
        reminds_us_of: string | null;
      }>('assessments', { application_id: app.id }),
      store.count('claims', { application_id: app.id }),
    ]);

  // Areas in rubric order, not database order, so the table reads the same way
  // on every application.
  const areas: AreaRow[] = CRITERIA.map((criterion) => {
    const row = scoreRows.find((r) => r.criterion_key === criterion.key);
    if (!row) return null;
    return {
      key: criterion.key,
      name: criterion.name,
      score: Number(row.score),
      ratingWord: row.rating_word,
      confidence: row.confidence as 'high' | 'med' | 'low',
      plain: row.plain,
      ask: row.ask,
      gap: row.gap_named,
      citedClaims: (row.claim_ids ?? []).length,
    } satisfies AreaRow;
  }).filter((a): a is AreaRow => a !== null);

  const sorted = [...areas].sort((a, b) => b.score - a.score);
  const best = sorted[0] ?? null;
  const worst = sorted[sorted.length - 1] ?? null;

  // "Reminds us of": the past decision whose REASONING this most resembles.
  //
  // Matched against the memo's "why we invested/passed" and founder assessment,
  // not against what the company does. Matching on the product picked HopBox
  // (ten-minute grocery delivery) as the precedent for a millet snack brand —
  // superficially food-adjacent, and useless. What makes a precedent worth showing
  // is the argument the partners made, so the query is this application's own
  // argument: what it does, plus the strongest and weakest things found in it.
  let remindsUsOf: ApplicationView['remindsUsOf'] = null;
  const query = [app.one_liner ?? '', best?.plain ?? '', worst?.plain ?? '']
    .filter(Boolean)
    .join(' ');

  if (query.trim().length > 0) {
    const reasoningPassages = await store.select<{ memo_id: string; section: string; embedding: unknown }>(
      'memo_passages',
    );
    const candidates = reasoningPassages.filter(
      (p) => p.section === 'why' || p.section === 'founder_assessment',
    );

    if (candidates.length > 0) {
      const { embed } = await import('./gateway/index');
      const { cosine } = await import('./db/store');
      try {
        const [vector] = await embed([query], { step: 'reminds_us_of' });
        // Best score per memo, so a memo with two matching sections does not simply
        // outrank one with a single stronger section.
        const bestByMemo = new Map<string, number>();
        for (const passage of candidates) {
          const raw = passage.embedding;
          const vec = Array.isArray(raw)
            ? (raw as number[])
            : typeof raw === 'string'
              ? (JSON.parse(raw) as number[])
              : null;
          if (!vec) continue;
          const similarity = cosine(vector, vec);
          const memoId = String(passage.memo_id);
          if (similarity > (bestByMemo.get(memoId) ?? -1)) bestByMemo.set(memoId, similarity);
        }

        const top = [...bestByMemo.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top) {
          const memo = await store.selectOne<{ company: string; decision: string; why: string }>('memos', {
            id: top[0],
          });
          if (memo) remindsUsOf = { company: memo.company, decision: memo.decision, why: memo.why };
        }
      } catch {
        // Retrieval is a nicety on this screen. If embeddings are unavailable the
        // precedent is omitted rather than the page failing to render.
        remindsUsOf = null;
      }
    }
  }

  const scored = areas.length > 0;
  const ratingWord = assessment?.rating_word ?? 'Thin';

  return {
    slug: app.slug,
    company: app.company_name,
    oneLiner: app.one_liner,
    sector: app.sector_declared,
    stage: app.stage_declared,
    location: app.location,
    raiseDisplay: app.raise_inr === null ? '—' : formatINR(Number(app.raise_inr)),
    postMoneyDisplay: app.post_money_text ?? '—',
    deckPages: documents.find((d) => d.kind === 'deck')?.page_count ?? 0,
    formPages: documents.find((d) => d.kind === 'form')?.page_count ?? 0,

    scored,
    ratingWord,
    segments: segmentsFor(ratingWord),
    lane: assessment?.lane ?? null,
    recommendation: assessment?.recommendation ?? null,

    ourTake: buildOurTake(areas, assessment?.recommendation ?? null),
    forIt: best ? best.plain : null,
    againstIt: worst && worst.key !== best?.key ? worst.plain : null,
    wouldChangeOurMind: buildWouldChange(areas),
    remindsUsOf,

    gates: gateRows.map((g) => ({
      key: g.gate_key,
      plainName: g.plain_name,
      reason: g.reason,
      tripped: Boolean(g.tripped),
      decidedBy: g.decided_by,
    })),
    areas,
    checks: checkRows
      .map((c) => ({
        key: c.check_key,
        title: c.title,
        severity: c.severity as CheckRow['severity'],
        formula: c.formula,
        expected: c.expected,
        found: c.found,
        plain: c.plain,
      }))
      .sort((a, b) => {
        const order = { red: 0, warn: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      }),
    founders: founderRows
      .sort((a, b) => a.token.localeCompare(b.token))
      .map((f) => ({ token: f.token, role: f.role, background: f.background_form })),
    claimCount,
  };
}

export async function listApplicationSlugs(): Promise<string[]> {
  const store = await getStore();
  const rows = await store.select<{ slug: string }>('applications');
  return rows.map((r) => r.slug);
}
