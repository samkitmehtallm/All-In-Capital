/**
 * The email linter.
 *
 * The brief's rule is "a deterministic linter decides; the model only drafts",
 * and that word *decides* is the whole design. No score, no judgement call, no
 * model in the loop: a draft either satisfies every rule or it comes back with a
 * list of what to fix, up to three times. Nothing here calls a model, and
 * nothing here is allowed to.
 *
 * Each failure carries a `fix` written to be pasted straight into the next
 * generation's prompt, because the brief asks that each attempt be "told exactly
 * what failed". A failure that says "too long" teaches nothing; one that says
 * "94 words, cut 14" does.
 *
 * ## Why the rules are what they are
 *
 * Every rule below was checked against the 58 clean emails Riya actually sent
 * (`tests/email-lint.test.ts`). The brief is explicit that this is the test that
 * matters: "check that all of Riya's clean emails pass the checks (a check Riya
 * fails is a wrong check)." The rule list itself is the brief's; the judgement
 * here is only in how each one is read, and where a reading had to change to
 * stop failing her own emails, it says so.
 */

export const TEMPLATES = ['call_invite', 'dig', 'pass', 'follow_up'] as const;
export type Template = (typeof TEMPLATES)[number];

/** Generations allowed before the composer gives up and hands over the draft. */
export const MAX_GENERATIONS = 3;

export interface LintFailure {
  /** Stable id, so a failure can be counted across drafts without parsing prose. */
  rule: string;
  /** What is wrong, for the person reading the lint panel. */
  message: string;
  /** What to do about it, for the next generation's prompt. */
  fix: string;
}

export interface LintResult {
  passed: boolean;
  failures: LintFailure[];
  wordCount: number;
}

export interface LintInput {
  template: Template;
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

/** Banned outright, from the brief. */
const BANNED_WORDS = [
  'delve',
  'leverage',
  'utilize',
  'robust',
  'cutting-edge',
  'game-changer',
  'transformative',
  'reach out',
  'touch base',
  'circle back',
  'synergy',
  'hope this finds you',
];

/**
 * Praise, banned in invites.
 *
 * "unusual" and "rare" are deliberately absent: they are how Riya frames a
 * number in 58 of 58 emails, and they are observations about a statistic rather
 * than compliments about a person. The brief's own wording, "no praise unless
 * it's backed by a specific fact", is already enforced by the rule below that
 * makes the first sentence cite a number.
 */
const PRAISE_WORDS = [
  'impressive',
  'impressed',
  'amazing',
  'incredible',
  'fantastic',
  'excellent',
  'outstanding',
  'remarkable',
  'brilliant',
  'exciting',
  'excited',
  'thrilled',
  'love what',
  'loved what',
  'great work',
  'great job',
  'well done',
  'congratulations',
  'congrats',
  'compelling',
  'inspiring',
];

/** Openers that spend a line saying nothing. */
const THROAT_CLEARING = [
  'i hope this',
  'hope this',
  'hope you are well',
  "hope you're well",
  'hope all is well',
  'i wanted to',
  'i just wanted to',
  'i am writing to',
  "i'm writing to",
  'i am reaching out',
  'i came across',
  'we came across',
  'my name is',
  'allow me to introduce',
  'first of all',
  'thank you for taking the time',
];

/** Sign-offs that summarise instead of stopping. */
const SUMMARY_SIGNOFFS = [
  'looking forward to hearing',
  'look forward to hearing',
  'feel free to',
  'do not hesitate',
  "don't hesitate",
  'in summary',
  'to summarise',
  'to summarize',
  'in conclusion',
  'kind regards',
  'warm regards',
  'best regards',
  'warmest regards',
  'yours sincerely',
  'yours faithfully',
];

/**
 * Accusation, banned in a pass.
 *
 * A pass has to be able to say what was missing without telling a founder they
 * lied. The line is between naming a gap ("we could not match the revenue figure
 * to the form") and naming a motive.
 */
const ACCUSATION_WORDS = [
  'misleading',
  'misrepresent',
  'inflated',
  'exaggerat',
  'overstat',
  'dishonest',
  'untrue',
  'false claim',
  'inconsistenc',
  'discrepanc',
  'contradict',
  'does not add up',
  "doesn't add up",
  'red flag',
  'concerning',
  'suspicious',
  'questionable',
];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_WORDS: Record<Template, number> = {
  call_invite: 80,
  dig: 120,
  pass: 120,
  follow_up: 120,
};

const QUESTION_RANGE: Record<Template, { min: number; max: number }> = {
  call_invite: { min: 1, max: 2 },
  dig: { min: 1, max: 2 },
  pass: { min: 0, max: 1 },
  follow_up: { min: 0, max: 1 },
};

export const MAX_SUBJECT_WORDS = 7;

/**
 * How to fix an opening with no number, per template.
 *
 * The rule is the brief's and it is deliberately unscoped: every one of the four
 * templates opens on a number, because the alternative is opening on a sentence
 * about the email itself. But the advice differs. Telling a decline to explain
 * "why it is unusual for this stage" asks it to compliment a company it is about
 * to turn down, and a model given that instruction will either flatter or ignore
 * it. Three generations of a GrainKind pass were spent finding that out.
 */
const OPENING_FIX: Record<Template, string> = {
  call_invite:
    'Open with one specific number from their traction and why it is unusual for this stage and sector.',
  dig: 'Open with the number you want settled, quoted as they stated it. Then ask for it.',
  pass:
    'Open with the number that decided it, stated flatly and with no judgement attached. Delete any sentence about having reviewed or received the application.',
  follow_up:
    'Open with the number from your first email, so they know which thread this is without scrolling.',
};

export const SLOT_1 = '{slot_1}';
export const SLOT_2 = '{slot_2}';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Stand-in for a full stop that does not end a sentence.
 *
 * Written as an escape rather than typed literally: a raw NUL in the source made
 * git treat this whole file as binary, which means no one can ever read a diff
 * of the rules. Any character outside the text would do; this one cannot occur
 * in an email.
 */
const SENTINEL = '\u0000';

/** The greeting line, so rules about the opening do not trip on "Hi [F1],". */
const GREETING_RE = /^\s*(hi|hello|hey|dear)\b[^\n]*\n/i;

export function bodyAfterGreeting(body: string): string {
  return body.replace(GREETING_RE, '').trimStart();
}

/**
 * The first sentence of the body proper.
 *
 * Decimals and the dot in "Rs." would end a sentence early, which matters
 * precisely here, because the next rule asks whether this sentence holds a
 * number. They are masked before the split and restored after.
 */
export function firstSentence(body: string): string {
  const after = bodyAfterGreeting(body);
  const masked = after.replace(/(\d)\.(\d)/g, `$1${SENTINEL}$2`).replace(/\bRs\./gi, `Rs${SENTINEL}`);
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(masked);
  const sentence = match ? match[0] : masked.split(/\n\n/)[0];
  return sentence.split(SENTINEL).join('.').trim();
}

/** A digit, a percentage, or a number written as a word. */
const NUMBER_RE =
  /\d|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|double|triple|twice)\b/i;

/**
 * Two offered times.
 *
 * A draft carries the literal placeholders, because the brief keeps the real
 * times out until send: "{slot_1} and {slot_2} stay as placeholders in the
 * draft". A sent email carries two concrete days instead. Both satisfy the rule,
 * and they have to: every one of Riya's 58 clean emails offers two real dates,
 * so a rule demanding the literal placeholder would fail all 58 and would, by
 * the brief's own test, be the wrong rule.
 */
const WEEKDAY_RE = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/gi;

export function offersTwoTimes(body: string): boolean {
  if (body.includes(SLOT_1) && body.includes(SLOT_2)) return true;
  const days = body.match(WEEKDAY_RE) ?? [];
  return days.length >= 2;
}

function found(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((n) => lower.includes(n));
}

function list(items: string[]): string {
  return items.map((i) => `"${i}"`).join(', ');
}

// ---------------------------------------------------------------------------
// The linter
// ---------------------------------------------------------------------------

export function lintEmail(input: LintInput): LintResult {
  const { template, subject, body } = input;
  const failures: LintFailure[] = [];
  const wordCount = countWords(body);

  const fail = (rule: string, message: string, fix: string) => failures.push({ rule, message, fix });

  // -- length ---------------------------------------------------------------

  const maxWords = MAX_WORDS[template];
  if (wordCount > maxWords) {
    fail(
      'length',
      `${wordCount} words; the limit for ${template} is ${maxWords}.`,
      `Cut ${wordCount - maxWords} words. Remove whole sentences rather than trimming adjectives.`,
    );
  }

  const subjectWords = countWords(subject);
  if (subject.trim().length === 0) {
    fail('subject_missing', 'No subject.', `Add a subject of at most ${MAX_SUBJECT_WORDS} words.`);
  } else if (subjectWords > MAX_SUBJECT_WORDS) {
    fail(
      'subject_length',
      `Subject is ${subjectWords} words; the limit is ${MAX_SUBJECT_WORDS}.`,
      `Rewrite the subject in ${MAX_SUBJECT_WORDS} words or fewer.`,
    );
  }

  // -- the opening ----------------------------------------------------------

  const opener = firstSentence(body);
  if (!NUMBER_RE.test(opener)) {
    fail(
      'first_sentence_number',
      `The first sentence cites no number: "${opener.slice(0, 80)}"`,
      OPENING_FIX[template],
    );
  }

  const openingLower = bodyAfterGreeting(body).toLowerCase();
  const clearing = THROAT_CLEARING.filter((p) => openingLower.startsWith(p));
  if (clearing.length > 0) {
    fail(
      'throat_clearing',
      `Opens with ${list(clearing)}.`,
      'Delete the opening line. Start with the number itself.',
    );
  }

  // -- questions ------------------------------------------------------------

  const questions = (body.match(/\?/g) ?? []).length;
  const range = QUESTION_RANGE[template];
  if (questions < range.min) {
    fail(
      'questions',
      `${questions} question marks; ${template} needs at least ${range.min}.`,
      template === 'call_invite'
        ? 'Ask one sharp question about the number you cited, and offer the two times as a question.'
        : 'Ask one sharp question about the number you cited.',
    );
  }
  if (questions > range.max) {
    fail(
      'questions',
      `${questions} question marks; ${template} allows at most ${range.max}.`,
      `Keep the sharpest question and turn the rest into statements. Remove ${questions - range.max}.`,
    );
  }

  // -- the invite's two times -----------------------------------------------

  if (template === 'call_invite' && !offersTwoTimes(body)) {
    fail(
      'slots',
      `The invite offers no two times; ${SLOT_1} and ${SLOT_2} are missing.`,
      `Offer both times using the literal placeholders ${SLOT_1} and ${SLOT_2}. Do not invent dates: they are filled from the calendar at send.`,
    );
  }

  // -- tone -----------------------------------------------------------------

  if (template === 'call_invite') {
    const praise = found(body, PRAISE_WORDS);
    if (praise.length > 0) {
      fail('praise', `Praise in an invite: ${list(praise)}.`, 'Delete the praise. The number is the compliment.');
    }
  }

  if (template === 'pass') {
    const accusing = found(body, ACCUSATION_WORDS);
    if (accusing.length > 0) {
      fail(
        'accusation',
        `A pass that accuses: ${list(accusing)}.`,
        'Name what was missing, not what you think they did. Say what you could not verify, not that they misstated it.',
      );
    }
  }

  // -- banned language ------------------------------------------------------

  const banned = found(body, BANNED_WORDS);
  if (banned.length > 0) {
    fail('banned_words', `Banned: ${list(banned)}.`, `Remove ${list(banned)} and say it plainly.`);
  }

  if (/—|–/.test(body)) {
    fail(
      'em_dash',
      'Contains an em dash or en dash.',
      'Replace every dash of that kind with a full stop, a comma, or a new sentence.',
    );
  }

  // The "not X but Y" construction, not the words themselves.
  if (/\bnot\b[^.?!]{1,40}?\bbut\b/i.test(body)) {
    fail(
      'not_x_but_y',
      'Uses the "not X but Y" construction.',
      'State the positive directly. Drop the "not ... but ..." framing.',
    );
  }

  const signoffs = found(body, SUMMARY_SIGNOFFS);
  if (signoffs.length > 0) {
    fail(
      'summary_signoff',
      `Sign-off padding: ${list(signoffs)}.`,
      `Remove ${list(signoffs)}. End with the question, then the signature.`,
    );
  }

  // -- signature ------------------------------------------------------------

  if (!/\briya\b/i.test(body)) {
    fail('signature', 'Not signed "Riya".', 'Sign it "Riya" on its own line, then "All In Capital".');
  }

  return { passed: failures.length === 0, failures, wordCount };
}

/** The lint feedback, as it goes into the next generation's prompt. */
export function failuresAsPrompt(failures: LintFailure[]): string {
  return failures.map((f, i) => `${i + 1}. ${f.message} ${f.fix}`).join('\n');
}
