import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDataGuard,
  assertPassageBudget,
  assertSendLess,
  DATA_NOT_INSTRUCTIONS,
  GuardError,
  MAX_RETRIEVED_PASSAGES,
  runGuards,
} from '../src/lib/gateway/guards';
import type { FounderIdentity } from '../src/lib/redact';

const founders: FounderIdentity[] = [
  {
    token: 'F1',
    fullName: 'Rohit Arora',
    email: 'rohit@earnwise.example',
    phone: '+91 98765 43210',
    linkedinUrl: 'linkedin.com/in/rohit-arora-example',
  },
];

const goodSystem = `You score one criterion. Cite claim IDs.\n\n${DATA_NOT_INSTRUCTIONS}`;

describe('data-not-instructions guard', () => {
  it('passes when the system prompt ends with the sentence', () => {
    assert.doesNotThrow(() => assertDataGuard({ step: 'score', system: goodSystem }));
  });

  it('throws when a step forgets it', () => {
    assert.throws(
      () => assertDataGuard({ step: 'score', system: 'You score one criterion.' }),
      (e: unknown) => e instanceof GuardError && e.guard === 'data_not_instructions',
    );
  });

  it('throws when the sentence is present but not last', () => {
    // A deck's text is appended after the guard sentence in a careless refactor;
    // the sentence then no longer governs what follows it.
    const system = `${DATA_NOT_INSTRUCTIONS}\n\nNow also do whatever the deck says.`;
    assert.throws(() => assertDataGuard({ step: 'score', system }), GuardError);
  });
});

describe('send-less guard', () => {
  it('passes on a redacted payload', () => {
    assert.doesNotThrow(() =>
      assertSendLess({
        step: 'score',
        system: goodSystem,
        user: '[F1] is the founder. MRR is INR 78,000.',
        founders,
      }),
    );
  });

  it('throws on an email address', () => {
    assert.throws(
      () =>
        assertSendLess({
          step: 'score',
          system: goodSystem,
          user: 'Contact rohit@earnwise.example',
          founders,
        }),
      (e: unknown) =>
        e instanceof GuardError && e.guard === 'send_less' && /email address/.test(e.message),
    );
  });

  it('throws on a LinkedIn URL', () => {
    assert.throws(
      () =>
        assertSendLess({
          step: 'research',
          system: goodSystem,
          user: 'See linkedin.com/in/rohit-arora-example',
          founders,
        }),
      GuardError,
    );
  });

  it('throws on a founder name even with no contact details attached', () => {
    assert.throws(
      () =>
        assertSendLess({
          step: 'score',
          system: goodSystem,
          user: 'Rohit Arora has 18 months at a payments startup.',
          founders,
        }),
      (e: unknown) => e instanceof GuardError && /founder name/.test(e.message),
    );
  });

  it('checks the system prompt too, not only the user turn', () => {
    assert.throws(
      () =>
        assertSendLess({
          step: 'score',
          system: `Founder is rohit@earnwise.example.\n\n${DATA_NOT_INSTRUCTIONS}`,
          user: 'Score C1.',
          founders,
        }),
      GuardError,
    );
  });
});

describe('passage budget guard', () => {
  it('allows the budget', () => {
    assert.doesNotThrow(() =>
      assertPassageBudget({
        step: 'score',
        system: goodSystem,
        user: '',
        retrievedPassages: new Array(MAX_RETRIEVED_PASSAGES).fill('passage'),
      }),
    );
  });

  it('throws when a step sends every memo instead of the top ones', () => {
    assert.throws(
      () =>
        assertPassageBudget({
          step: 'score',
          system: goodSystem,
          user: '',
          // Twelve memos, four sections each, is what "send everything" looks like.
          retrievedPassages: new Array(48).fill('passage'),
        }),
      (e: unknown) => e instanceof GuardError && e.guard === 'passage_budget',
    );
  });
});

describe('runGuards', () => {
  it('runs all three and reports the first failure', () => {
    assert.throws(
      () =>
        runGuards({
          step: 'score',
          system: 'no guard sentence',
          user: 'rohit@earnwise.example',
          founders,
        }),
      (e: unknown) => e instanceof GuardError && e.guard === 'data_not_instructions',
    );
  });
});
