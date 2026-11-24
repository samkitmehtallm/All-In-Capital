import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPII, redact, type FounderIdentity } from '../src/lib/redact';

/**
 * The founders below are the real ones from data/raw. Their contact details are
 * fictional in the source material, but the redaction behaviour has to hold for the
 * exact strings the ingest step will encounter.
 */
const earnwise: FounderIdentity[] = [
  {
    token: 'F1',
    fullName: 'Rohit Arora',
    email: 'rohit@earnwise.example',
    phone: '+91 98765 43210',
    linkedinUrl: 'linkedin.com/in/rohit-arora-example',
  },
];

const carecorner: FounderIdentity[] = [
  { token: 'F1', fullName: 'Dr. Lakshmi Reddy', linkedinUrl: 'linkedin.com/in/lakshmi-reddy-example' },
  { token: 'F2', fullName: 'Vikram Rao', linkedinUrl: 'linkedin.com/in/vikram-rao-example' },
];

describe('redact', () => {
  it('replaces a founder name with their token', () => {
    const { text } = redact('Rohit Arora, Founder and CEO. Full-time since January 2026.', earnwise);
    assert.equal(text, '[F1], Founder and CEO. Full-time since January 2026.');
  });

  it('replaces the name parts too, because decks use first names alone', () => {
    const { text } = redact('Rohit built the payroll integration himself.', earnwise);
    assert.equal(text, '[F1] built the payroll integration himself.');
  });

  it('strips the title before matching, so "Dr. Lakshmi Reddy" still resolves', () => {
    const { text } = redact('Dr. Lakshmi Reddy, CEO. MBBS, 8 years in family medicine.', carecorner);
    assert.match(text, /\[F1\], CEO\./);
    assert.doesNotMatch(text, /Lakshmi|Reddy/);
  });

  it('keeps founders distinct', () => {
    const { text } = redact('Lakshmi designs the protocols. Vikram runs site selection.', carecorner);
    assert.equal(text, '[F1] designs the protocols. [F2] runs site selection.');
  });

  it('removes contact details entirely, not just the named ones', () => {
    const input =
      'Reach Rohit at rohit@earnwise.example or +91 98765 43210, ' +
      'linkedin.com/in/rohit-arora-example. Also someone@else.example.';
    const { text } = redact(input, earnwise);
    assert.doesNotMatch(text, /@earnwise\.example/);
    assert.doesNotMatch(text, /98765/);
    assert.doesNotMatch(text, /linkedin\.com/);
    // An address belonging to nobody on the form is still an address.
    assert.doesNotMatch(text, /someone@else\.example/);
    assert.match(text, /\[EMAIL\]/);
  });

  it('collapses the repeated token left by redacting a full name and its parts', () => {
    const { text } = redact('Rohit Arora and Rohit', earnwise);
    assert.equal(text, '[F1] and [F1]');
  });

  it('reports what it replaced, without echoing the values', () => {
    const { replacements } = redact('rohit@earnwise.example, Rohit Arora', earnwise);
    const kinds = replacements.map((r) => r.kind);
    assert.ok(kinds.includes('email'));
    assert.ok(kinds.includes('name'));
    const serialised = JSON.stringify(replacements);
    assert.doesNotMatch(serialised, /rohit@earnwise/);
  });

  it('leaves text with nothing to redact untouched', () => {
    const input = 'Monthly recurring revenue INR 78,000 across 24 paying CA firms.';
    assert.equal(redact(input, earnwise).text, input);
  });
});

describe('findPII', () => {
  it('finds what redaction would have removed', () => {
    // The message now names what matched, masked, so a false positive is
    // diagnosable without hunting through a 20KB prompt.
    assert.match(findPII('rohit@earnwise.example')[0], /^email address \("roh…le", 22 chars\)$/);
    assert.match(findPII('linkedin.com/in/x')[0], /^LinkedIn URL \(/);
    assert.doesNotMatch(findPII('rohit@earnwise.example')[0], /rohit@earnwise/);
    assert.ok(findPII('Rohit Arora', earnwise).includes('founder name (F1)'));
  });

  it('finds nothing in already-redacted text', () => {
    const { text } = redact(
      'Rohit Arora, rohit@earnwise.example, +91 98765 43210, linkedin.com/in/rohit-arora-example',
      earnwise,
    );
    assert.deepEqual(findPII(text, earnwise), []);
  });

  it('does not mistake a rupee figure for a phone number', () => {
    // "INR 38 L disbursed" and "1,600 workers" must not read as contact details.
    assert.deepEqual(findPII('INR 38 L disbursed since July 2026 to 1,600 workers'), []);
  });
});
