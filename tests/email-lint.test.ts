/**
 * The linter, tested against Riya.
 *
 * The brief names the test that matters: "check that all of Riya's clean emails
 * pass the checks (a check Riya fails is a wrong check)." So the first suite
 * below runs the linter over all 60 rows of her real export. It is the only test
 * here that can condemn a rule rather than a draft, and when it fails the rule
 * is what gets changed.
 *
 * The rest are the ordinary direction: given a bad draft, does the right rule
 * fire, and does its message say enough to fix it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadLoop2Examples, rankExamples, similarityTextFor } from '../src/lib/email/examples';
import {
  countWords,
  firstSentence,
  lintEmail,
  offersTwoTimes,
  MAX_SUBJECT_WORDS,
  SLOT_1,
  SLOT_2,
} from '../src/lib/email/lint';
import { parseCsv } from '../src/lib/ingest/csv';

const CSV = readFileSync('data/raw/B6_Loop2_Email_Export.csv', 'utf8');
const ROWS = parseCsv(CSV);

/** A draft that passes everything, as the base for one-rule-at-a-time tests. */
const GOOD_INVITE = [
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

const invite = (body: string, subject = 'Your sensor retention') =>
  lintEmail({ template: 'call_invite', subject, body });

describe('the export parses at all', () => {
  it('reads 60 rows with multi-paragraph emails intact', () => {
    assert.equal(ROWS.length, 60);
    assert.equal(ROWS[0].row_id, 'L2-001', 'the BOM on the first header must not hide the column');
    assert.ok(ROWS[0].riya_final_email.includes('\n'), 'a quoted field spanning lines must stay one field');
    assert.ok(ROWS.every((r) => r.riya_final_email.trim().length > 0));
  });
});

describe("Riya's own emails", () => {
  const linted = ROWS.map((row) => ({
    id: row.row_id,
    result: lintEmail({
      template: 'call_invite',
      // The export has no subject column, so a passing placeholder keeps the
      // subject rules from deciding this test.
      subject: 'placeholder subject',
      body: row.riya_final_email,
    }),
  }));

  it('passes 58 of 60, failing only the two planted rows', () => {
    const failed = linted.filter((l) => !l.result.passed).map((l) => l.id);
    assert.equal(linted.length - failed.length, 58);
    assert.deepEqual(
      failed.sort(),
      ['L2-030', 'L2-054'],
      'any other failure means a rule is wrong, not that the email is',
    );
  });

  it('fails the 136-word email for its length, and nothing else', () => {
    const row = linted.find((l) => l.id === 'L2-030')!;
    assert.deepEqual(row.result.failures.map((f) => f.rule), ['length']);
    assert.match(row.result.failures[0].message, /136 words/);
    assert.match(row.result.failures[0].fix, /Cut 56 words/);
  });

  it('fails the "Dear Ms / Kind regards" email for the two things wrong with it', () => {
    const row = linted.find((l) => l.id === 'L2-054')!;
    assert.deepEqual(row.result.failures.map((f) => f.rule).sort(), ['slots', 'summary_signoff']);
  });

  it('is the reason "unusual" and "rare" are not praise words', () => {
    // 58 of 58 use one or the other. A praise list containing them would fail
    // every clean email she wrote, which the brief says makes the list wrong.
    const framing = ROWS.filter((r) => /\b(unusual|rare)\b/i.test(r.riya_final_email));
    assert.ok(framing.length >= 55, `only ${framing.length} use it; check before relying on this`);
  });

  it('is the reason the Aditya line is not a lint rule', () => {
    // L2-057 is a hardware founder she invited without mentioning Aditya. The
    // composer always adds the line; the linter must not fail a draft for it,
    // or this email of hers would fail too.
    const row = ROWS.find((r) => r.row_id === 'L2-057')!;
    assert.equal(row.founder_type, 'hardware');
    assert.ok(!row.riya_final_email.includes('Aditya'));
    assert.ok(lintEmail({ template: 'call_invite', subject: 'ok', body: row.riya_final_email }).passed);
  });

  it('keeps every clean email inside the invite word limit with room to spare', () => {
    const clean = ROWS.filter((r) => !['L2-030', 'L2-054'].includes(r.row_id));
    const counts = clean.map((r) => countWords(r.riya_final_email));
    assert.ok(Math.max(...counts) <= 80);
    assert.ok(Math.min(...counts) >= 40, 'a floor this far from the cap means 80 is the right cap');
  });
});

describe('length and subject', () => {
  it('counts the overage and says how much to cut', () => {
    const long = GOOD_INVITE + ' ' + 'word '.repeat(60);
    const result = invite(long);
    const failure = result.failures.find((f) => f.rule === 'length')!;
    assert.match(failure.message, /the limit for call_invite is 80/);
    assert.match(failure.fix, /^Cut \d+ words/);
  });

  it('allows 120 words for the other three templates', () => {
    const body = ['Hi [F1],', '', '42% repeat is unusual at pre-seed.', 'word '.repeat(90), 'Riya'].join('\n');
    assert.ok(countWords(body) > 80 && countWords(body) <= 120);
    assert.ok(!lintEmail({ template: 'dig', subject: 'One number', body }).failures.some((f) => f.rule === 'length'));
    assert.ok(lintEmail({ template: 'call_invite', subject: 'One number', body }).failures.some((f) => f.rule === 'length'));
  });

  it('rejects a subject over seven words, and an empty one', () => {
    const eight = 'One quick question about your retention number please';
    assert.equal(countWords(eight), 8);
    assert.ok(invite(GOOD_INVITE, eight).failures.some((f) => f.rule === 'subject_length'));
    assert.ok(invite(GOOD_INVITE, '   ').failures.some((f) => f.rule === 'subject_missing'));
    assert.ok(invite(GOOD_INVITE, 'Seven words is the limit here now').passed, `${MAX_SUBJECT_WORDS} must be allowed`);
  });
});

describe('the first sentence', () => {
  it('does not end a sentence inside a decimal', () => {
    const body = GOOD_INVITE.replace('1,900 sensors', 'A 2.4x increase in sensors');
    assert.match(firstSentence(body), /2\.4x increase/);
  });

  it('skips the greeting line', () => {
    assert.ok(!firstSentence(GOOD_INVITE).startsWith('Hi'));
    assert.match(firstSentence(GOOD_INVITE), /^1,900 sensors/);
  });

  it('fails a draft that opens without a number', () => {
    const body = GOOD_INVITE.replace(
      '1,900 sensors sold with 83% still reporting after a year is unusual at seed.',
      'Your retention looks unusual for a company at this stage.',
    );
    const failure = invite(body).failures.find((f) => f.rule === 'first_sentence_number')!;
    assert.ok(failure, 'a sentence with no digits must fail');
    assert.match(failure.message, /Your retention looks unusual/);
  });

  it('accepts a number written as a word, because she writes "Zero credit loss"', () => {
    const body = GOOD_INVITE.replace(
      '1,900 sensors sold with 83% still reporting after a year is unusual at seed.',
      'Zero credit loss across fourteen months is unusual at seed.',
    );
    assert.ok(!invite(body).failures.some((f) => f.rule === 'first_sentence_number'));
  });

  it('fails a throat-clearing opener', () => {
    const body = GOOD_INVITE.replace('Hi [F1],\n', 'Hi [F1],\n\nI hope this email finds you well.\n');
    assert.ok(invite(body).failures.some((f) => f.rule === 'throat_clearing'));
  });
});

describe('questions and times', () => {
  it('allows one or two question marks in an invite and no more', () => {
    assert.ok(invite(GOOD_INVITE).passed);
    const three = GOOD_INVITE.replace('distributors?', 'distributors? And what is the churn?');
    const failure = invite(three).failures.find((f) => f.rule === 'questions')!;
    assert.match(failure.message, /3 question marks/);
    assert.match(failure.fix, /Remove 1/);
  });

  it('allows a pass to ask nothing, and at most one thing', () => {
    const body = ['Hi [F1],', '', '410 bookings at 14% repeat is early for this stage.', '', 'We will pass for now.', '', 'Riya'].join('\n');
    assert.ok(lintEmail({ template: 'pass', subject: 'Thanks for sending this', body }).passed);
  });

  it('counts the literal placeholders as two offered times', () => {
    assert.ok(offersTwoTimes(`Would 30 minutes on ${SLOT_1} or ${SLOT_2} work?`));
    assert.ok(!offersTwoTimes(`Would 30 minutes on ${SLOT_1} work?`));
  });

  it('counts two real weekdays as two offered times, as her sent emails have', () => {
    assert.ok(offersTwoTimes('Could we do 30 minutes on Tuesday 20 May or Thursday 22 May?'));
    assert.ok(!offersTwoTimes('Could we do 30 minutes on Tuesday 20 May?'));
  });

  it('tells a draft with no times to use the placeholders, not to invent dates', () => {
    const body = GOOD_INVITE.replace(
      `Would 30 minutes on ${SLOT_1} or ${SLOT_2} work? If neither suits you, reply with a time that does.`,
      'Are you free for 30 minutes next week?',
    );
    const failure = invite(body).failures.find((f) => f.rule === 'slots')!;
    assert.match(failure.fix, /Do not invent dates/);
  });
});

describe('tone', () => {
  it('fails praise in an invite but not in a pass', () => {
    const body = GOOD_INVITE.replace('1,900 sensors', 'Impressive work. 1,900 sensors');
    assert.ok(invite(body).failures.some((f) => f.rule === 'praise'));
    assert.ok(!lintEmail({ template: 'pass', subject: 'Thanks', body }).failures.some((f) => f.rule === 'praise'));
  });

  it('fails a pass that accuses, and passes one that only names a gap', () => {
    const accuses = ['Hi [F1],', '', 'The 31 paying firms figure looks inflated against your form.', '', 'Riya'].join('\n');
    assert.ok(lintEmail({ template: 'pass', subject: 'Thanks for sending', body: accuses }).failures.some((f) => f.rule === 'accusation'));

    const names = ['Hi [F1],', '', 'We could not match the 31 paying firms on the deck to the 24 on the form.', '', 'We will pass for now.', '', 'Riya'].join('\n');
    assert.ok(lintEmail({ template: 'pass', subject: 'Thanks for sending', body: names }).passed);
  });

  it('fails em dashes, banned words, "not X but Y" and padded sign-offs', () => {
    const cases: Array<[string, string]> = [
      ['em_dash', GOOD_INVITE.replace('is unusual at seed.', 'is unusual at seed — genuinely.')],
      ['banned_words', GOOD_INVITE.replace('How many', 'Happy to circle back. How many')],
      ['not_x_but_y', GOOD_INVITE.replace('is unusual', 'is not typical but unusual')],
      ['summary_signoff', GOOD_INVITE.replace('Riya\n', 'Kind regards,\nRiya\n')],
    ];
    for (const [rule, body] of cases) {
      assert.ok(invite(body).failures.some((f) => f.rule === rule), `${rule} should have fired`);
    }
  });

  it('fails a draft not signed Riya', () => {
    assert.ok(invite(GOOD_INVITE.replace('Riya\n', 'Best,\n')).failures.some((f) => f.rule === 'signature'));
  });
});

describe('the examples loop', () => {
  const loaded = loadLoop2Examples(CSV);

  it('keeps exactly the 58 emails the linter approves of', () => {
    assert.equal(loaded.clean.length, 58);
    assert.deepEqual(loaded.rejected.map((r) => r.sourceRowId).sort(), ['L2-030', 'L2-054']);
  });

  it('stores examples already masked, so nothing downstream can leak a name', () => {
    const yash = loaded.clean.find((e) => e.sourceRowId === 'L2-001')!;
    assert.ok(yash.body.includes('[F1]'));
    assert.ok(!/\bYash\b/.test(yash.body));
    assert.ok(loaded.clean.every((e) => !/@/.test(e.body)));
  });

  it('matches on the situation, not on the prose', () => {
    const text = similarityTextFor({ sector: 'Fintech', stage: 'Seed', founderType: 'software', tractionFacts: 'Zero credit loss' });
    assert.match(text, /Sector: Fintech/);
    assert.match(text, /Traction: Zero credit loss/);
    assert.ok(!text.includes('Hi '), 'the email body must not be what is compared');
  });

  it('returns three, most similar first, breaking ties towards the shorter email', () => {
    const scored = [
      { example: { id: 'a', wordCount: 60 }, similarity: 0.9 },
      { example: { id: 'b', wordCount: 44 }, similarity: 0.9 },
      { example: { id: 'c', wordCount: 50 }, similarity: 0.95 },
      { example: { id: 'd', wordCount: 48 }, similarity: 0.1 },
    ];
    assert.deepEqual(rankExamples(scored).map((e) => e.id), ['c', 'b', 'a']);
  });
});
