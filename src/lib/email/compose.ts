/**
 * The composer.
 *
 * The model drafts; the linter decides. This file is the loop between them.
 *
 * Up to three generations. Each failed draft goes back with the exact list of
 * what broke, because a model told "that was too long" writes something else
 * too long, and one told "94 words, cut 14, remove whole sentences" does not.
 *
 * ## What happens when all three fail
 *
 * The draft with the fewest failures is handed over anyway, with `lintPassed`
 * false and every failure listed in the panel. The alternative, showing nothing,
 * is worse: Riya is waiting on this at 8pm, and a flawed draft she can fix in
 * thirty seconds beats an empty box. Nothing auto-sends either way, so the cost
 * of a bad draft is bounded by her reading it.
 *
 * ## What the model never sees
 *
 * Founder names arrive as `[F1]`, and emails, phones and LinkedIn URLs never
 * reach it at all. The gateway's send-less guard throws rather than trusting
 * this file to have remembered. The recipient address is attached at send time,
 * by the route, after the draft exists.
 */

import { z } from 'zod';

import { examplesAsPrompt } from './examples';
import {
  failuresAsPrompt,
  lintEmail,
  MAX_GENERATIONS,
  SLOT_1,
  SLOT_2,
  type LintFailure,
  type LintResult,
  type Template,
} from './lint';
import { callModel } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../gateway/guards';
import type { FounderIdentity } from '../redact';

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** One fact the email may cite. Already extracted and reconciled. */
export interface DraftFact {
  metric: string;
  valueText: string;
  period: string | null;
}

export interface ComposeInput {
  applicationId: string;
  company: string;
  sector: string;
  stage: string;
  /** 'software' | 'hardware' | 'services'. Decides whether Aditya is mentioned. */
  founderType: string;
  template: Template;
  /** What the form says about the founder, names already masked. */
  founderBackground: string;
  /** Traction the pipeline verified. The first sentence must cite one of these. */
  facts: DraftFact[];
  /** For dig and pass: what did not line up, in Riya's words, not the system's. */
  openQuestions: string[];
  /**
   * The assessment's own reasoning, so a decline or a dig is grounded in why the
   * system reached its view rather than in a reason the model invents.
   *
   * This was added after a GrainKind pass declined it for a 38% repeat rate
   * being "too low". The repeat rate is the best thing about GrainKind; the
   * actual problem is a market size stated at ten times its own inputs. Given
   * only the traction numbers and no reasoning, a model will manufacture a
   * rationale from whatever it was handed, and a rejection built on a made-up
   * reason is worse than no email at all.
   */
  reasoning: { againstIt: string | null; wouldChange: string | null } | null;
  /** Three of her real sent emails, most similar first. */
  examples: Array<{ body: string; sector: string; stage: string }>;
  /** Passed to the guard so it can check the draft against real contacts. */
  founders: FounderIdentity[];
  /** A redo chip, or free text from "redo with a note". */
  note?: string | null;
  traceId?: string;
}

export interface ComposeResult {
  subject: string;
  body: string;
  /** 1, 2 or 3. */
  generation: number;
  lint: LintResult;
  /** Every attempt, oldest first. Saved; there is no version-history UI. */
  attempts: Array<{ subject: string; body: string; failures: LintFailure[] }>;
  costInr: number;
  model: string;
  traceId: string;
}

const DraftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
} as const;

// ---------------------------------------------------------------------------
// Redo chips
// ---------------------------------------------------------------------------

/**
 * The five chips from the brief, as instructions rather than labels.
 *
 * "Warmer" is the one worth watching: warmth in an invite cannot come from
 * praise, because praise is a lint failure. So it is spent on the sentence
 * structure instead, which is also what Riya does.
 */
export const REDO_CHIPS = {
  shorter: 'Cut it by about a quarter. Lose a whole sentence, not adjectives.',
  warmer:
    'Warmer, but no praise: praise fails the checks. Warmth comes from a shorter first sentence and a question that shows you read the form.',
  more_direct: 'Say the ask in the first six words of the sentence that contains it. Remove every hedge.',
  different_opening: 'Open on a different number from the ones given. Do not reuse the current first sentence.',
  sharper_question:
    'Replace the question. Ask about the one number that would change the decision, in a form they can answer with a figure.',
} as const;

export type RedoChip = keyof typeof REDO_CHIPS;

export function noteForChip(chip: RedoChip): string {
  return REDO_CHIPS[chip];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** What each template is for, in the second person. */
const TEMPLATE_BRIEF: Record<Template, string> = {
  call_invite:
    `Invite them to a 30-minute call. Shape, in order: "Hi [F1]," then one specific number from their traction and why it is unusual for this stage and sector, then one sharp question about that number, then "Would 30 minutes on ${SLOT_1} or ${SLOT_2} work? If neither suits you, reply with a time that does.", then "Riya" and "All In Capital" on the next line.`,
  dig: 'Ask for the one or two things that would settle the decision. No call yet. Shape, in order: "Hi [F1]," then the number you want settled quoted as they stated it, then exactly what you want and in what form. Be specific: a table, a date range, a cohort.',
  pass:
    'Decline. Shape, in order: "Hi [F1]," then the one number that decided it stated flatly, then the decision in one sentence, then one short sentence leaving the door open, then the signature. Never open with "We reviewed your application" or anything else about the email itself. Say what was missing, never what you suspect. Do not offer a call. Do not praise: a compliment attached to a rejection reads as insincere.',
  follow_up:
    'Follow up on an email that got no reply. Open with the number from the first email so they know the thread, then repeat the single most important question, and nothing else. Do not apologise for following up and do not say "just checking in".',
};

function buildSystem(input: ComposeInput): string {
  const aditya =
    input.template === 'call_invite' && isDeeptech(input.founderType)
      ? '\nThis is a hardware or deeptech founder, so add exactly this sentence before the signature: "Our partner Aditya will join us for the technical part."'
      : '';

  return [
    'You write the first email to a founder on behalf of Riya, an associate at All In Capital, an early-stage Indian fund.',
    '',
    `Task: ${TEMPLATE_BRIEF[input.template]}${aditya}`,
    '',
    'Her standard, which a deterministic checker enforces after you:',
    '- Short. One clear ask.',
    '- No praise. The number you cite is the compliment.',
    '- The first sentence cites a specific number.',
    '- Signed "Riya".',
    '- Never these: em dashes, "delve", "leverage", "utilize", "robust", "cutting-edge", "game-changer", "transformative", "reach out", "touch base", "circle back", "synergy", "hope this finds you", "not X but Y", an opening line that says nothing, a sign-off that summarises.',
    input.template === 'call_invite'
      ? `- Keep ${SLOT_1} and ${SLOT_2} as literal placeholders. Never write a real date: the times are filled from Riya's calendar at the moment of sending.`
      : '',
    '',
    'Write as she writes, not as a template. The example emails below are real emails she sent; match their register and length, not their sentences.',
    '',
    'Reply as JSON: {"subject": "...", "body": "..."}. The subject is at most 7 words. The body includes the greeting and the signature.',
    '',
    DATA_NOT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildUser(input: ComposeInput, previous?: { body: string; failures: LintFailure[] }): string {
  const facts = input.facts.length
    ? input.facts
        .map((f) => `- ${f.metric}: ${f.valueText}${f.period ? ` (${f.period})` : ''}`)
        .join('\n')
    : '- (No verified traction numbers.)';

  const sections = [
    `Company: ${input.company}`,
    `Sector: ${input.sector}`,
    `Stage: ${input.stage}`,
    '',
    'Founder, from their form:',
    input.founderBackground || '(Not stated.)',
    '',
    'Traction we verified. Cite one of these, and only these:',
    facts,
  ];

  if (input.openQuestions.length > 0) {
    sections.push('', 'What did not line up:', input.openQuestions.map((q) => `- ${q}`).join('\n'));
  }

  // The reason is the point of a decline and the subject of a dig, so it goes in
  // for both. An invite does not get it: the case against is not what you open a
  // first conversation with.
  if (input.reasoning && input.template !== 'call_invite') {
    if (input.template === 'pass' && input.reasoning.againstIt) {
      sections.push(
        '',
        'Why we are passing. Base the email on this, not on the traction numbers above:',
        input.reasoning.againstIt,
      );
    }
    if (input.template === 'dig' && input.reasoning.wouldChange) {
      sections.push(
        '',
        'What would change our mind. This is what to ask for:',
        input.reasoning.wouldChange,
      );
    }
  }

  sections.push('', "Three emails Riya actually sent, most similar first:", '', examplesAsPrompt(input.examples));

  if (input.note) {
    sections.push('', `Riya asked for this change: ${input.note}`);
  }

  if (previous) {
    sections.push(
      '',
      'Your previous draft failed these checks. Fix every one. Keep everything that was already right:',
      '',
      previous.body.trim(),
      '',
      failuresAsPrompt(previous.failures),
    );
  }

  return sections.join('\n');
}

/** Hardware and deeptech founders get Aditya on the call. */
export function isDeeptech(founderType: string): boolean {
  return /hardware|deeptech|deep tech/i.test(founderType);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Draft, lint, and redraft up to three times.
 *
 * Returns the first draft that passes. If none does, returns the one with the
 * fewest failures, breaking a tie towards the earliest, which is the one written
 * with the least accumulated instruction and tends to read most like her.
 */
export async function composeEmail(input: ComposeInput): Promise<ComposeResult> {
  const attempts: ComposeResult['attempts'] = [];
  let previous: { body: string; failures: LintFailure[] } | undefined;
  let costInr = 0;
  let model = '';
  let traceId = input.traceId ?? '';

  for (let generation = 1; generation <= MAX_GENERATIONS; generation += 1) {
    const response = await callModel({
      step: `email:${input.template}:gen${generation}`,
      system: buildSystem(input),
      user: buildUser(input, previous),
      // Not zero: a redraft at temperature 0 given the same facts tends to
      // return the same sentence with the offending word deleted, which usually
      // fails a different rule instead.
      temperature: 0.4,
      responseSchema: DRAFT_JSON_SCHEMA,
      founders: input.founders,
      applicationId: input.applicationId,
      traceId: input.traceId,
    });

    costInr += response.costInr;
    model = response.model;
    traceId = response.traceId;

    const parsed = DraftSchema.safeParse(response.json);
    if (!parsed.success) {
      // A reply that is not a draft is not a generation: it taught the model
      // nothing and there is nothing to lint. Retry without spending one.
      previous = undefined;
      attempts.push({ subject: '', body: response.text, failures: [{ rule: 'unparsable', message: 'The model did not return a draft.', fix: 'Reply as JSON with "subject" and "body".' }] });
      continue;
    }

    const { subject, body } = parsed.data;
    const lint = lintEmail({ template: input.template, subject, body });
    attempts.push({ subject, body, failures: lint.failures });

    if (lint.passed) {
      return { subject, body, generation, lint, attempts, costInr, model, traceId };
    }

    previous = { body, failures: lint.failures };
  }

  // Three strikes. Hand over the least-broken attempt rather than nothing.
  const best = attempts.reduce((a, b) => (b.failures.length < a.failures.length ? b : a));
  const lint = lintEmail({ template: input.template, subject: best.subject, body: best.body });

  return {
    subject: best.subject,
    body: best.body,
    generation: MAX_GENERATIONS,
    lint,
    attempts,
    costInr,
    model,
    traceId,
  };
}
