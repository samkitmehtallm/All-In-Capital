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

export type Lane = 'worth_a_call' | 'check_first' | 'dig_first' | 'not_now';

export const LANES: Array<{ key: Lane; label: string; hint: string }> = [
  { key: 'worth_a_call', label: 'Worth a call', hint: 'Scored 7.5 or above with no gate tripped' },
  { key: 'check_first', label: 'Check first', hint: 'A rule tripped. You still decide' },
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

export interface BookedMeeting {
  company: string;
  slug: string;
  startsAt: string;
  adityaInvited: boolean;
}

export interface Board {
  headline: string;
  /** Fixed, because it is the one thing Riya needs to know about how this works. */
  subtitle: string;
  cards: BoardCard[];
  scoredCount: number;
  /** The fifth strip: what the tool booked without her, so it is never a surprise. */
  bookedThisWeek: BookedMeeting[];
  /** What this screen cannot show yet, said plainly rather than left blank. */
  pending: string | null;
}

/**
 * Monday 00:00 of the current week, in IST.
 *
 * "This week" has to mean the same thing to Riya as it does to the query, and she
 * is in Delhi, so the boundary is computed in IST rather than from the host clock.
 */
function startOfIstWeek(now = new Date()): Date {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - day);
  return new Date(monday - 5.5 * 3600 * 1000);
}

/**
 * Is the configured store actually usable?
 *
 * Returns a sentence for the screen, or null when all is well.
 */
async function describeUnreachableStore(store: Awaited<ReturnType<typeof getStore>>): Promise<string | null> {
  if (store.kind === 'local' && (store as { writable?: boolean }).writable === false) {
    return (
      'This deployment is set to the local file store, which cannot be written to on ' +
      'a serverless host. Set DATA_BACKEND to supabase and add SUPABASE_URL and ' +
      'SUPABASE_SERVICE_KEY, then redeploy.'
    );
  }

  try {
    await store.count('applications');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `The database could not be reached: ${message}`;
  }
}

function notConnected(reason: string): Board {
  return {
    headline: 'Not connected to the database.',
    subtitle: 'You decide. Once you send the letter, the app books the meeting.',
    cards: [],
    scoredCount: 0,
    bookedThisWeek: [],
    pending: reason,
  };
}

export async function getBoard(): Promise<Board> {
  // getStore() itself throws when DATA_BACKEND=supabase and the service key is
  // absent, which is the most likely state of a fresh deployment. Catching it
  // here is what turns that into a screen rather than a stack trace.
  let store: Awaited<ReturnType<typeof getStore>>;
  try {
    store = await getStore();
  } catch (error) {
    return notConnected(error instanceof Error ? error.message : String(error));
  }

  // A store that is reachable but unusable is the same class of problem, and the
  // person reading this screen cannot fix either from here. Say which setting is
  // wrong in plain words rather than showing an empty board that looks broken.
  const unreachable = await describeUnreachableStore(store);
  if (unreachable) return notConnected(unreachable);

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

    // A tripped rule puts it in the Check first lane even before anything is scored.
    // Riya still decides; the lane only changes the order she reads things in.
    const lane: Lane | null = assessment?.lane ?? (g1.tripped ? 'check_first' : null);

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

  // Meetings the tool booked on its own. Riya clicked send on the first letter and
  // nothing else, so this strip is how she finds out what happened next.
  const weekStart = startOfIstWeek();
  const events = await store.select<{
    application_id: string;
    starts_at: string;
    aditya_invited: boolean;
  }>('calendar_events');
  const bookedThisWeek: BookedMeeting[] = events
    .filter((e) => new Date(e.starts_at).getTime() >= weekStart.getTime())
    .map((e) => {
      const app = applications.find((a) => a.id === e.application_id);
      return {
        company: app?.company_name ?? 'Unknown',
        slug: app?.slug ?? '',
        startsAt: e.starts_at,
        adityaInvited: Boolean(e.aditya_invited),
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return {
    headline: buildHeadline(cards.length, scoredCount, gated.length),
    subtitle: 'You decide. Once you send the letter, the app books the meeting.',
    cards,
    scoredCount,
    bookedThisWeek,
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
 * "Two worth a call; three to check first." is the target shape. Before scoring there
 * is nothing to count, so it says what is actually true instead.
 */
function buildHeadline(total: number, scored: number, gated: number): string {
  if (total === 0) return 'Nothing in the pile.';
  if (scored === 0) {
    const gatePart =
      gated === 1
        ? 'One to check first'
        : gated > 1
          ? `${spell(gated)} to check first`
          : 'None has tripped a rule';
    return `${spell(total)} applications read. ${gatePart}.`;
  }
  return `${spell(scored)} of ${spell(total)} scored; ${spell(gated)} to check first.`;
}

function spell(n: number): string {
  const words = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const word = words[n];
  return word ?? String(n);
}
