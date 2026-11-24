/**
 * Drafting for a real application: gather the facts, retrieve the examples,
 * compose, and save.
 *
 * Kept apart from `compose.ts` so that the generation loop stays a pure function
 * of its inputs and can be tested without a database. This file is the part that
 * knows where the facts live.
 *
 * The brief's order matters here: a draft is written "only after Riya opens the
 * application or asks for it", never as part of the queue. Drafting on ingest
 * would spend a model call on all hundred applications a month when she writes
 * to about seventeen of them.
 *
 * Deliberately NOT marked `server-only`, for the same reason as the queue
 * runners: `pnpm draft` imports this module, and that marker throws the moment a
 * plain Node process loads it. The marker is also not transitive, so having it
 * here was never protecting `getStore` anyway. What enforces the boundary is an
 * architecture test asserting that no client component imports this file, which
 * covers the runners too and holds whether or not anyone remembers the import.
 */

import { composeEmail, type ComposeInput, type ComposeResult } from './compose';
import { EXAMPLES_PER_DRAFT, rankExamples, similarityTextFor } from './examples';
import { lintEmail, type Template } from './lint';
import { getApplication } from '../application';
import { getStore } from '../db/index';
import { embed } from '../gateway/index';
import { redact, type FounderIdentity } from '../redact';

/** The suggested template follows the recommendation (brief §8). */
export function templateForRecommendation(recommendation: string | null): Template {
  if (recommendation === 'take_call') return 'call_invite';
  if (recommendation === 'dig_first') return 'dig';
  if (recommendation === 'pass') return 'pass';
  return 'dig';
}

interface ApplicationRow {
  [key: string]: unknown;
  id: string;
  company_name: string;
  status: string;
  sector_resolved: string | null;
  sector_declared: string | null;
  stage_declared: string | null;
}

interface ClaimRow {
  [key: string]: unknown;
  metric: string;
  value_text: string | null;
  period: string | null;
  is_target: boolean;
  canonical: string | null;
}

interface CheckRow {
  [key: string]: unknown;
  severity: string;
  plain: string | null;
}

interface FounderRow {
  [key: string]: unknown;
  id: string;
  token: string;
  background_form: string | null;
}

/**
 * software, hardware or services, in the B6 export's vocabulary.
 *
 * There is no such column on an application: it is the sector that decides
 * whether a call needs Aditya, and the sector is already resolved by the gates.
 * Deriving it here keeps one source of truth rather than a second field that can
 * disagree with the first.
 */
export function founderTypeForSector(sector: string | null): string {
  if (!sector) return 'software';
  if (/deeptech|deep tech|hardware|robotics|manufactur/i.test(sector)) return 'hardware';
  if (/service|consult|agency|clinic|healthcare/i.test(sector)) return 'services';
  return 'software';
}

/**
 * Retrieve the three most similar emails Riya actually sent.
 *
 * Matched on the situation, not the prose. Returns fewer than three without
 * complaint: an empty table is a cold start, not a fault, and the prompt says
 * so rather than pretending it has examples.
 */
export async function retrieveExamples(
  template: Template,
  situation: { sector: string; stage: string; founderType: string; tractionFacts: string },
): Promise<Array<{ body: string; sector: string; stage: string }>> {
  const store = await getStore();
  if ((await store.count('style_examples', { template })) === 0) return [];

  const [vector] = await embed([similarityTextFor(situation)], { step: 'email_examples' });
  const hits = await store.nearest<{ body: string; sector: string; stage: string; word_count: number }>({
    table: 'style_examples',
    column: 'embedding',
    embedding: vector,
    limit: EXAMPLES_PER_DRAFT,
    where: { template },
  });

  return rankExamples(
    hits.map((h) => ({
      example: {
        body: h.row.body,
        sector: h.row.sector,
        stage: h.row.stage,
        // snake_case at the column, camelCase everywhere above it.
        wordCount: Number(h.row.word_count ?? 0),
      },
      similarity: h.similarity,
    })),
    EXAMPLES_PER_DRAFT,
  ).map((row) => ({ body: row.body, sector: row.sector, stage: row.stage }));
}

export interface DraftRequest {
  /** The slug, not the id: the reasoning comes from the same view the page shows. */
  slug: string;
  template?: Template;
  /** A redo chip's instruction, or free text from "redo with a note". */
  note?: string | null;
}

export interface SavedDraft extends ComposeResult {
  id: string;
  template: Template;
  /** The failures, for the live lint panel. */
  examplesShown: number;
}

/**
 * Compose a draft for one application and save it.
 *
 * Every previous draft for the application is marked `is_current = false` rather
 * than deleted: the brief keeps versions in the database while showing no
 * version history, so the rows exist for the cost report and for the §11
 * experiment, and nothing in the UI reads them.
 */
export async function draftForApplication(request: DraftRequest): Promise<SavedDraft> {
  const store = await getStore();

  // The whole view, not a handful of columns.
  //
  // The assessments table has `for_it`, `against_it` and `would_change` columns
  // that nothing writes: the narrative is derived at read time from the
  // criterion scores. Reading those columns gave three passes in a row that
  // declined a company for its best number, because the reasoning was null and
  // the model filled the gap itself. Going through the same function the screen
  // uses means the email can only argue what Riya can see it arguing.
  const view = await getApplication(request.slug);
  if (!view) throw new Error(`No application "${request.slug}".`);

  const app = await store.selectOne<ApplicationRow>('applications', { slug: request.slug });
  if (!app) throw new Error(`No application "${request.slug}".`);

  if (!view.scored) {
    throw new Error(
      `${view.company} has not been scored yet, so there is no recommendation to write from.`,
    );
  }

  const template = request.template ?? templateForRecommendation(view.recommendation);
  const sector = view.sector ?? 'unknown';
  const stage = view.stage ?? 'unknown';
  const founderType = founderTypeForSector(sector);

  const claims = await store.select<ClaimRow>('claims', { application_id: app.id });
  const founderRows = await store.select<FounderRow>('founders', { application_id: app.id });

  // Targets are what the founder intends to do, not what they have done. An
  // email that opens on a projection and calls it unusual is embarrassing.
  const facts = claims
    .filter((c) => !c.is_target && c.value_text)
    .map((c) => ({ metric: c.metric, valueText: String(c.value_text), period: c.period }));

  // Only what failed reconciliation, in the plain wording the screen shows.
  const openQuestions = view.checks
    .filter((c) => c.severity === 'red' || c.severity === 'warn')
    .map((c) => c.plain)
    .filter((q): q is string => Boolean(q));

  // Contacts hang off a founder, not an application, and the founders table
  // holds no name at all -- which is the point of splitting them. The gateway
  // needs the real values so it can check that no draft contains them.
  const founders: FounderIdentity[] = [];
  for (const f of founderRows) {
    const contact = await store.selectOne<{
      full_name: string | null;
      email: string | null;
      phone: string | null;
      linkedin_url: string | null;
    }>('founder_contacts', { founder_id: f.id });
    founders.push({
      token: f.token,
      fullName: contact?.full_name ?? '',
      email: contact?.email ?? null,
      phone: contact?.phone ?? null,
      linkedinUrl: contact?.linkedin_url ?? null,
    });
  }

  // The background is masked here, not merely labelled. `background_form` is the
  // form's own prose and routinely names the founder inside it ("Priya led the
  // ops team..."), so prefixing a token would leave the name in the sentence.
  // This is the mistake the scorer made once already.
  const founderBackground = founderRows
    .map((f) => {
      const { text } = redact(f.background_form ?? '', founders);
      return `[${f.token}] ${text}`.trim();
    })
    .join('\n');

  const examples = await retrieveExamples(template, {
    sector,
    stage,
    founderType,
    tractionFacts: facts.map((f) => `${f.metric} ${f.valueText}`).join('; '),
  });

  const input: ComposeInput = {
    applicationId: String(app.id),
    company: view.company,
    sector,
    stage,
    founderType,
    template,
    founderBackground,
    facts,
    openQuestions,
    reasoning: { againstIt: view.againstIt, wouldChange: view.wouldChangeOurMind },
    examples,
    founders,
    note: request.note ?? null,
  };

  const result = await composeEmail(input);

  await store.update('email_drafts', { application_id: app.id, is_current: true }, { is_current: false });

  const [row] = await store.insert('email_drafts', {
    application_id: app.id,
    template,
    subject: result.subject,
    body: result.body,
    generation: result.generation,
    lint_passed: result.lint.passed,
    lint_failures: result.lint.failures,
    model: result.model,
    is_current: true,
  });

  return { ...result, id: String(row.id), template, examplesShown: examples.length };
}

/**
 * Re-lint an edited draft and save the edit.
 *
 * The composer's lint result belongs to what the model wrote. The moment Riya
 * types, that result is about a draft that no longer exists, so the panel has to
 * be recomputed from what is on screen. No model is involved in an edit.
 */
export async function saveEdit(input: {
  draftId: string;
  subject: string;
  body: string;
}): Promise<{ lint: ReturnType<typeof lintEmail> }> {
  const store = await getStore();

  const draft = await store.selectOne<{ template: string }>('email_drafts', { id: input.draftId });
  if (!draft) throw new Error(`No draft ${input.draftId}`);

  const lint = lintEmail({
    template: draft.template as Template,
    subject: input.subject,
    body: input.body,
  });

  await store.update(
    'email_drafts',
    { id: input.draftId },
    {
      subject: input.subject,
      body: input.body,
      lint_passed: lint.passed,
      lint_failures: lint.failures,
      edited_at: new Date().toISOString(),
    },
  );

  return { lint };
}
