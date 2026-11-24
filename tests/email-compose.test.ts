/**
 * The composer loop.
 *
 * What is worth proving here is not that a model can write an email. It is that
 * the linter, and only the linter, decides whether a draft is acceptable; that a
 * rejected draft goes back with the specific reason; and that three failures end
 * with Riya holding something she can edit rather than an empty box.
 *
 * The offline provider stands in for the model, so each generation returns
 * exactly the draft this test wants to put in front of the linter.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LocalStore } from '../src/lib/db/local';
import { setStore } from '../src/lib/db/index';
import { composeEmail, isDeeptech, noteForChip, REDO_CHIPS, type ComposeInput } from '../src/lib/email/compose';
import { MAX_GENERATIONS, SLOT_1, SLOT_2 } from '../src/lib/email/lint';
import { registerOfflineHandler } from '../src/lib/gateway/providers/offline';

let dir: string;
/** What each generation was asked, so the feedback loop can be inspected. */
let prompts: string[];

const draft = (body: string, subject = 'Your sensor retention') => JSON.stringify({ subject, body });

const PASSING = [
  'Hi [F1],',
  '',
  '1,900 sensors sold with 83% still reporting after a year is unusual at seed.',
  '',
  'How many of those were bought by farmers rather than distributors?',
  '',
  `Would 30 minutes on ${SLOT_1} or ${SLOT_2} work? If neither suits you, reply with a time that does.`,
  '',
  'Riya',
  'All In Capital',
].join('\n');

/**
 * Same email, with one praise word. Fails exactly one rule.
 *
 * The praise goes after the opening deliberately. Putting it first would also
 * push the number out of the first sentence and fail a second rule, which makes
 * it a poor fixture for testing one failure at a time.
 */
const PRAISING = PASSING.replace('How many of those', 'Impressive numbers. How many of those');

/** Same email, far too long. */
const BLOATED = PASSING.replace('Riya', `${'filler '.repeat(70)}\n\nRiya`);

function input(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    applicationId: 'app-1',
    company: 'Pumpwise',
    sector: 'Deeptech',
    stage: 'Seed',
    founderType: 'hardware',
    template: 'call_invite',
    founderBackground: '[F1] ran irrigation projects for nine years.',
    facts: [{ metric: 'sensors sold', valueText: '1,900', period: 'to date' }],
    openQuestions: [],
    reasoning: null,
    examples: [{ body: PASSING, sector: 'Deeptech', stage: 'Seed' }],
    founders: [{ token: 'F1', fullName: 'Sudha Rao', email: 'sudha@pumpwise.in', phone: '9876543210' }],
    ...overrides,
  };
}

/** Register a handler per generation, returning the given drafts in order. */
function willReturn(...bodies: string[]) {
  bodies.forEach((body, i) => {
    registerOfflineHandler(`email:call_invite:gen${i + 1}`, (req) => {
      prompts.push(req.user);
      return body;
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aic-email-'));
  setStore(new LocalStore(dir));
  process.env.MODEL_PROVIDER = 'offline';
  process.env.TRACE_FILE = join(dir, 'traces.jsonl');
  delete process.env.DAILY_SPEND_CAP_INR;
  prompts = [];
});

afterEach(() => {
  setStore(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('the generation loop', () => {
  it('stops at the first draft that passes', async () => {
    willReturn(draft(PASSING), draft(PRAISING), draft(PRAISING));

    const result = await composeEmail(input());

    assert.equal(result.generation, 1);
    assert.ok(result.lint.passed);
    assert.equal(result.attempts.length, 1, 'a passing draft must not be redrafted');
    assert.equal(prompts.length, 1);
  });

  it('redrafts a failing draft and tells it exactly what failed', async () => {
    willReturn(draft(PRAISING), draft(PASSING));

    const result = await composeEmail(input());

    assert.equal(result.generation, 2);
    assert.ok(result.lint.passed);
    assert.equal(result.attempts[0].failures[0].rule, 'praise');

    // The second prompt must carry the rejected draft and the reason.
    const second = prompts[1];
    assert.match(second, /failed these checks/);
    assert.match(second, /Praise in an invite: "impressive"/);
    assert.match(second, /Delete the praise\. The number is the compliment\./);
    assert.match(second, /Impressive numbers/, 'the model needs to see what it wrote');
  });

  it('gives the number of words to cut, not just "too long"', async () => {
    willReturn(draft(BLOATED), draft(PASSING));

    await composeEmail(input());

    assert.match(prompts[1], /\d+ words; the limit for call_invite is 80/);
    assert.match(prompts[1], /Cut \d+ words/);
  });

  it('hands over the least-broken draft after three failures rather than nothing', async () => {
    // Two rules broken, then one, then two again.
    const twoRules = PRAISING.replace('is unusual at seed.', 'is unusual at seed — truly.');
    willReturn(draft(twoRules), draft(PRAISING), draft(twoRules));

    const result = await composeEmail(input());

    assert.equal(result.generation, MAX_GENERATIONS);
    assert.equal(result.lint.passed, false);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.body, PRAISING, 'the attempt with the fewest failures is the one to hand over');
    assert.deepEqual(result.lint.failures.map((f) => f.rule), ['praise']);
  });

  it('never spends a generation on a reply that is not a draft', async () => {
    registerOfflineHandler('email:call_invite:gen1', () => 'I cannot help with that.');
    registerOfflineHandler('email:call_invite:gen2', (req) => {
      prompts.push(req.user);
      return draft(PASSING);
    });

    const result = await composeEmail(input());

    assert.ok(result.lint.passed);
    assert.equal(result.attempts[0].failures[0].rule, 'unparsable');
    // The retry must not carry a "your previous draft failed" block, because
    // there was no previous draft to learn from.
    assert.ok(!prompts[0].includes('failed these checks'));
  });
});

describe('what reaches the model', () => {
  it('sends the facts and the examples, and never a contact detail', async () => {
    willReturn(draft(PASSING));

    await composeEmail(input());

    const prompt = prompts[0];
    assert.match(prompt, /sensors sold: 1,900/);
    assert.match(prompt, /she sent this one/);
    assert.ok(!prompt.includes('sudha@pumpwise.in'), 'the send-less guard would throw, but it must not get that far');
    assert.ok(!prompt.includes('9876543210'));
    assert.ok(!prompt.includes('Sudha'));
  });

  it('throws rather than send a founder email address the caller forgot to mask', async () => {
    willReturn(draft(PASSING));

    await assert.rejects(
      composeEmail(input({ founderBackground: 'Reach her at sudha@pumpwise.in about the pilot.' })),
      /sudha@pumpwise\.in|email address/i,
      'the guard is the backstop for exactly this mistake',
    );
  });

  it('passes the open questions through for a dig', async () => {
    registerOfflineHandler('email:dig:gen1', (req) => {
      prompts.push(req.user);
      return draft(['Hi [F1],', '', '31 paying firms on the deck against 24 on the form.', '', 'Which is current?', '', 'Riya'].join('\n'), 'Two numbers');
    });

    const result = await composeEmail(
      input({ template: 'dig', openQuestions: ['Deck says 31 paying firms; the form says 24 paying and 7 on trial.'] }),
    );

    assert.ok(result.lint.passed);
    assert.match(prompts[0], /What did not line up/);
    assert.match(prompts[0], /31 paying firms/);
  });
});

describe('Aditya and the redo chips', () => {
  it('asks for the Aditya line for hardware, and not for software', async () => {
    assert.ok(isDeeptech('hardware'));
    assert.ok(!isDeeptech('software'));
    assert.ok(!isDeeptech('services'));
  });

  it('puts a redo note in the prompt', async () => {
    willReturn(draft(PASSING));

    await composeEmail(input({ note: noteForChip('sharper_question') }));

    assert.match(prompts[0], /Riya asked for this change/);
    assert.match(prompts[0], /would change the decision/);
  });

  it('asks for warmth without asking for praise, which would fail the lint', () => {
    assert.match(REDO_CHIPS.warmer, /no praise/);
  });
});
