/**
 * Redaction.
 *
 * Founder names become [F1], [F2] before any prompt is built. Emails, phones and
 * LinkedIn URLs never reach a model at all (brief §2.3). Over-redaction is the safe
 * direction here: losing a surname that happens to be a common word costs the model
 * nothing, while leaking one costs the fund a founder's trust.
 *
 * This module only transforms text. The guard that *enforces* the rule, and throws,
 * is in gateway/guards.ts — redaction you have to remember to call is not a control.
 */

export interface FounderIdentity {
  /** 'F1' */
  token: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
}

export interface RedactionResult {
  text: string;
  /** What was replaced, for the audit trail. Never logged with the original values. */
  replacements: Array<{ kind: string; token: string; count: number }>;
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub|company)\/[A-Za-z0-9_-]+\/?/gi;
/** Indian mobile numbers, with or without +91, and any run of 10+ digits. */
export const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\b\d{10,}\b/g;

/** Words that are too generic to blanket-redact even when they are a surname. */
const UNSAFE_TO_REDACT = new Set(['the', 'and', 'for', 'in', 'of', 'a', 'an', 'is', 'to']);

/**
 * Replace every trace of the given founders with their tokens, then strip any
 * contact-shaped text that remains regardless of whose it is.
 */
export function redact(text: string, founders: FounderIdentity[] = []): RedactionResult {
  let out = text;
  const replacements: RedactionResult['replacements'] = [];

  const tally = (kind: string, token: string, count: number) => {
    if (count > 0) replacements.push({ kind, token, count });
  };

  // Named values first: these are the ones tied to a specific person.
  for (const f of founders) {
    for (const [kind, value] of [
      ['email', f.email],
      ['linkedin', f.linkedinUrl],
      ['phone', f.phone],
    ] as const) {
      if (!value) continue;
      const { text: next, count } = replaceAll(out, value, `[${f.token}_${kind.toUpperCase()}]`);
      out = next;
      tally(kind, f.token, count);
    }

    // Full name, then each name part long enough to be distinctive.
    const parts = f.fullName
      .replace(/^(?:Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, '')
      .split(/\s+/)
      .filter((p) => p.length >= 3 && !UNSAFE_TO_REDACT.has(p.toLowerCase()));

    const ordered = [f.fullName, ...parts.sort((a, b) => b.length - a.length)];
    let nameCount = 0;
    for (const needle of ordered) {
      const { text: next, count } = replaceWord(out, needle, `[${f.token}]`);
      out = next;
      nameCount += count;
    }
    tally('name', f.token, nameCount);
  }

  // Anything contact-shaped that survived, whoever it belongs to.
  out = countedReplace(out, EMAIL_RE, '[EMAIL]', (n) => tally('email', 'other', n));
  out = countedReplace(out, LINKEDIN_RE, '[LINKEDIN]', (n) => tally('linkedin', 'other', n));
  out = countedReplace(out, PHONE_RE, '[PHONE]', (n) => tally('phone', 'other', n));

  // Collapse "[F1] [F1]" left behind by redacting both a full name and its parts.
  out = out.replace(/(\[F\d+\])(?:\s+\1)+/g, '$1');

  return { text: out, replacements };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text: string, needle: string, token: string) {
  const re = new RegExp(escapeRe(needle), 'gi');
  const count = (text.match(re) ?? []).length;
  return { text: count ? text.replace(re, token) : text, count };
}

/** Word-boundary replace, so "Rao" does not fire inside "Raochester". */
function replaceWord(text: string, needle: string, token: string) {
  const re = new RegExp(`\\b${escapeRe(needle)}\\b`, 'gi');
  const count = (text.match(re) ?? []).length;
  return { text: count ? text.replace(re, token) : text, count };
}

function countedReplace(
  text: string,
  re: RegExp,
  token: string,
  onCount: (n: number) => void,
): string {
  const matches = text.match(new RegExp(re.source, re.flags));
  if (matches?.length) onCount(matches.length);
  return text.replace(new RegExp(re.source, re.flags), token);
}

/**
 * Does this text still contain anything that identifies a person?
 *
 * Used by the guard, and by the seed loader to assert that every redacted page it
 * writes is actually clean before it reaches the database.
 */
/**
 * Mask a matched value for an error message.
 *
 * A guard that says only "phone number" sends you hunting through a 20KB prompt;
 * one that says `phone number ("91…0000", 11 chars)` is actionable in seconds. The
 * middle is removed so a real leak is not fully reproduced in a log, which is the
 * whole thing this guard exists to prevent.
 */
function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 6) return `"${v[0] ?? ''}…", ${v.length} chars`;
  return `"${v.slice(0, 3)}…${v.slice(-2)}", ${v.length} chars`;
}

export function findPII(text: string, founders: FounderIdentity[] = []): string[] {
  const found: string[] = [];
  const emailMatch = new RegExp(EMAIL_RE.source, 'i').exec(text);
  if (emailMatch) found.push(`email address (${mask(emailMatch[0])})`);
  const liMatch = new RegExp(LINKEDIN_RE.source, 'i').exec(text);
  if (liMatch) found.push(`LinkedIn URL (${mask(liMatch[0])})`);
  const phoneMatch = new RegExp(PHONE_RE.source).exec(text);
  if (phoneMatch) found.push(`phone number (${mask(phoneMatch[0])})`);
  for (const f of founders) {
    const bare = f.fullName.replace(/^(?:Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, '');
    if (new RegExp(`\\b${escapeRe(bare)}\\b`, 'i').test(text)) found.push(`founder name (${f.token})`);
    for (const value of [f.email, f.phone, f.linkedinUrl]) {
      if (value && text.toLowerCase().includes(value.toLowerCase())) {
        found.push(`contact detail (${f.token})`);
      }
    }
  }
  return [...new Set(found)];
}
