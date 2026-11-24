import 'server-only';

/**
 * Board data.
 *
 * Lanes are computed, never chosen — cards drag nowhere (brief §13). Right now only
 * gate G1 is computed, because it is the one that needs no model: four comparisons
 * on numbers parsed from form fields. Everything else arrives with the scoring
 * pipeline, and until it does this screen says so in plain words rather than
 * showing an empty board that looks broken.
 */

import { getStore } from './db/index';
import { evaluateG1, type GateResult } from './gates/g1-stage-cheque';
import { formatINR } from './units';

export type Lane = 'worth_a_call' | 'kushal_decides' | 'dig_first' | 'not_now';

export const LANES: Array<{ key: Lane; label: string; hint: string }> = [
  { key: 'worth_a_call', label: 'Worth a call', hint: 'Scored 7.5 or above with no gate tripped' },
  { key: 'kushal_decides', label: 'Kushal decides', hint: 'A gate tripped. Never auto-rejected' },
  { key: 'dig_first', label: 'Dig first', hint: 'Scored 6.0 to 7.49, with questions to ask' },
  { key: 'not_now', label: 'Not now', hint: 'Below 6.0, with what would change our view' },
];

export interface BoardCard {
  slug: string;
  company: string;
  oneLiner: string | null;
  sectorDeclared: string | null;
  location: string | null;
  raiseInr: number | null;
  raiseDisplay: string;
  postMoneyDisplay: string;
  deckPages: number;
  formPages: number;
  founderCount: number;
  lane: Lane | null;
  /** Null until the scoring pipeline has run. */
  ratingWord: string | null;
  judgement: string | null;
  gates: GateResult[];
  /** 'read' once ingested; 'scored' once the pipeline has run. */
  state: 'read' | 'scored';
}

export interface Board {
  headline: string;
  cards: BoardCard[];
  scoredCount: number;
  /** What this screen cannot show yet, said plainly rather than left blank. */
  pending: string | null;
}

export async function getBoard(): Promise<Board> {
  const store = await getStore();

  const applications = await store.select<{
    id: string;
    slug: string;
    company_name: string;
    one_liner: string | null;
    sector_declared: string | null;
    location: string | null;
    raise_inr: number | null;
    raise_text: string | null;
    post_money_text: string | null;
    stage_declared: string | null;
  }>('applications');

  const cards: BoardCard[] = [];

  for (const app of applications) {
    const documents = await store.select<{ kind: string; page_count: number }>('documents', {
      application_id: app.id,
    });
    const founders = await store.select('founders', { application_id: app.id });
    const investorsField = await store.selectOne<{ value: string }>('form_fields', {
      application_id: app.id,
      label: 'Existing investors',
    });

    const g1 = evaluateG1({
      stageDeclared: app.stage_declared,
      raiseText: app.raise_text,
      postMoneyText: app.post_money_text,
      existingInvestorsText: investorsField?.value ?? null,
    });

    const assessment = await store.selectOne<{
      lane: Lane;
      rating_word: string;
      headline: string;
    }>('assessments', { application_id: app.id });

    // A tripped gate puts it in front of Kushal even before anything is scored.
    const lane: Lane | null = assessment?.lane ?? (g1.tripped ? 'kushal_decides' : null);

    cards.push({
      slug: app.slug,
      company: app.company_name,
      oneLiner: app.one_liner,
      sectorDeclared: app.sector_declared,
      location: app.location,
      raiseInr: app.raise_inr === null ? null : Number(app.raise_inr),
      raiseDisplay: app.raise_inr === null ? '—' : formatINR(Number(app.raise_inr)),
      postMoneyDisplay: app.post_money_text ?? '—',
      deckPages: documents.find((d) => d.kind === 'deck')?.page_count ?? 0,
      formPages: documents.find((d) => d.kind === 'form')?.page_count ?? 0,
      founderCount: founders.length,
      lane,
      ratingWord: assessment?.rating_word ?? null,
      judgement: assessment?.headline ?? null,
      gates: g1.tripped ? [g1] : [],
      state: assessment ? 'scored' : 'read',
    });
  }

  cards.sort((a, b) => a.company.localeCompare(b.company));

  const scoredCount = cards.filter((c) => c.state === 'scored').length;
  const gated = cards.filter((c) => c.gates.length > 0);

  return {
    headline: buildHeadline(cards.length, scoredCount, gated.length),
    cards,
    scoredCount,
    pending:
      scoredCount === 0
        ? 'Scoring has not run yet. Each application has been read and checked against the ' +
          'stage and cheque rules; the rest of the read — the numbers, the founders, and the ' +
          'score against our thesis — comes next.'
        : null,
  };
}

/**
 * The one-line headline, in plain words.
 *
 * "Two worth a call; three need Kushal." is the target shape. Before scoring there
 * is nothing to count, so it says what is actually true instead.
 */
function buildHeadline(total: number, scored: number, gated: number): string {
  if (total === 0) return 'Nothing in the pile.';
  if (scored === 0) {
    const gatePart =
      gated === 1
        ? 'One already needs Kushal'
        : gated > 1
          ? `${spell(gated)} already need Kushal`
          : 'None has tripped a rule yet';
    return `${spell(total)} applications read. ${gatePart}.`;
  }
  return `${spell(scored)} of ${spell(total)} scored; ${spell(gated)} need Kushal.`;
}

function spell(n: number): string {
  const words = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const word = words[n];
  return word ?? String(n);
}
