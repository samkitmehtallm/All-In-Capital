/**
 * Founder form parsing — deterministic, no model (brief §7.1).
 *
 * The ten forms come out of two different PDF exports. Nine of them extract as
 * "Label value" on one line; StockSathi's extracts one word per line with a blank
 * line between every word. Rather than handle two layouts, both are normalised to a
 * single space-separated string and then split on a dictionary of known labels.
 *
 * A model is not used here on purpose: a form field is a known key and a verbatim
 * value, and asking a model to copy it introduces the one failure mode (a quietly
 * altered number) that the whole reconciliation step exists to detect.
 */

/**
 * Every label that appears across the ten forms, longest first so that
 * "Revenue / GMV" wins over "Revenue" and "Founder 1" over "Founder".
 */
export const FORM_LABELS: string[] = [
  'Anything else we should know?',
  'Other investors in conversation',
  'How did you hear about us?',
  'Prior startup experience',
  'Valuation expectation',
  'Accuracy and liability',
  'Who else is doing this?',
  'What have you built?',
  'How is credit funded?',
  'Customer acquisition',
  'Patient acquisition',
  'Existing investors',
  'One-line description',
  'Sector (as selected)',
  'Stage (as selected)',
  'Earlier co-founder',
  'Funding of advances',
  'Volume and revenue',
  'Repeat behaviour',
  'Regulatory status',
  'Time commitment',
  'Evidence of value',
  'Active customers',
  'Credit book size',
  'Amount raising',
  'Defaults to date',
  'Why will you win?',
  'Unit economics',
  'Revenue / GMV',
  'Company name',
  'Incorporated',
  'Dependencies',
  'Use of funds',
  'Equity split',
  'Channel mix',
  'Competition',
  'Rent volume',
  'Team size',
  'Key risks',
  'Founder 1',
  'Founder 2',
  'Customers',
  'Location',
  'Advances',
  'Founder',
  'Revenue',
  'Website',
  'Workers',
  'Growth',
  'Repeat',
  'Capex',
  'Users',
];

/** Section headings, which are not fields and must not swallow the next value. */
const SECTION_HEADINGS = [
  'Company',
  'Founders',
  'Product and traction',
  'Fundraising',
  'Credit',
  'Competition and differentiation',
];

export interface ParsedField {
  label: string;
  value: string;
  pageNumber: number;
}

/**
 * Collapse every run of whitespace to one space.
 *
 * This is what makes the two PDF layouts the same problem. It also strips the
 * soft hyphens and non-breaking spaces these exports contain.
 */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/­/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split one page into label/value pairs.
 *
 * Labels are matched against the dictionary rather than inferred, so an unexpected
 * heading cannot become a field with the rest of the page as its value. Anything
 * before the first label is page chrome and is dropped.
 */
export function parseFormPage(pageText: string, pageNumber: number): ParsedField[] {
  const text = normaliseWhitespace(pageText);
  if (!text) return [];

  const pattern = new RegExp(`(?:${FORM_LABELS.map(escapeRe).join('|')})`, 'g');

  const hits: Array<{ label: string; start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const label = match[0];
    const start = match.index ?? 0;
    const end = start + label.length;
    // A label only counts at a word boundary, so "Revenue" inside "Net Revenue
    // retention" does not start a new field.
    const before = start === 0 ? ' ' : text[start - 1];
    if (!/[\s:|]/.test(before)) continue;
    // It must not be the prefix of a longer word or a hyphenated one: the heading
    // "Founders" and the phrase "Founder-led outbound" would otherwise both match
    // the label "Founder".
    const after = end >= text.length ? ' ' : text[end];
    if (/[A-Za-z-]/.test(after)) continue;
    // A label never follows a comma. ", Growth." in "Divya Menon, Growth." is a
    // role and "Rohit Arora, Founder and CEO" is a title; treating either as a new
    // field truncates the founder's value and loses their LinkedIn URL.
    const priorNonSpace = text.slice(0, start).trimEnd().slice(-1);
    if (priorNonSpace === ',') continue;
    hits.push({ label, start, end });
  }

  // Keep only the first hit per label *before* slicing values, so a label word
  // repeated inside a value does not cut that value short.
  const seenLabels = new Set<string>();
  const uniqueHits = hits.filter((h) => {
    if (seenLabels.has(h.label)) return false;
    seenLabels.add(h.label);
    return true;
  });

  const fields: ParsedField[] = [];
  for (let i = 0; i < uniqueHits.length; i += 1) {
    const hit = uniqueHits[i];
    const next = uniqueHits[i + 1];
    let value = text.slice(hit.end, next ? next.start : text.length).trim();

    // Drop a trailing section heading that belongs to the following block.
    for (const heading of SECTION_HEADINGS) {
      const re = new RegExp(`\\s*${escapeRe(heading)}$`, 'i');
      value = value.replace(re, '').trim();
    }

    value = value.replace(/^[:\-–|]\s*/, '').trim();
    if (value) fields.push({ label: hit.label, value, pageNumber });
  }

  // Keep the first occurrence of a label: later pages repeat the header chrome.
  const seen = new Set<string>();
  return fields.filter((f) => {
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  });
}

export function parseForm(pages: string[]): ParsedField[] {
  const all = pages.flatMap((text, i) => parseFormPage(text, i + 1));
  const seen = new Set<string>();
  return all.filter((f) => {
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  });
}

export function fieldValue(fields: ParsedField[], label: string): string | null {
  return fields.find((f) => f.label === label)?.value ?? null;
}

export interface ParsedFounder {
  ordinal: number;
  token: string;
  fullName: string;
  role: string | null;
  background: string;
  linkedinUrl: string | null;
}

/**
 * Pull founders out of the "Founder 1" / "Founder 2" / "Founder" fields.
 *
 * The name is whatever precedes the first comma or the role, which holds across all
 * ten forms: "Dhruv Shah, CEO. Qualified Chartered Accountant…", "Manish Joshi. 10
 * years running his family's travel agency…", "Aarav Deshmukh, CEO LinkedIn: …".
 */
export function parseFounders(fields: ParsedField[]): ParsedFounder[] {
  const founderFields = fields.filter((f) => /^Founder( \d)?$/.test(f.label));
  return founderFields.map((f, i) => {
    // Repair URLs the PDF broke across lines. "linkedin.com/in/ritu-\nhegde-example"
    // normalises to "...ritu- hegde-example", and a naive match stops at the space,
    // yielding a truncated profile URL that still looks plausible. Rejoin a hyphen
    // followed by whitespace, repeatedly, since a long slug can wrap twice.
    let value = f.value;
    for (let pass = 0; pass < 3; pass += 1) {
      const repaired = value.replace(
        /(linkedin\.com\/in\/[A-Za-z0-9_-]*)-\s+([A-Za-z0-9_-]+)/gi,
        '$1-$2',
      );
      if (repaired === value) break;
      value = repaired;
    }
    const linkedin = /((?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+)/i.exec(value);

    // Name: up to the first comma or full stop. The title is lifted off first,
    // because the full stop in "Dr. Lakshmi Reddy" would otherwise end the name
    // at "Dr". Single letters are allowed so "Meenakshi S" keeps its initial.
    const titleMatch = /^((?:Dr|Mr|Ms|Mrs|Prof)\.?\s+)/.exec(value);
    const title = titleMatch ? titleMatch[1] : '';
    const rest = value.slice(title.length);
    const head = rest.split(/[,.]/)[0]?.trim() ?? rest.trim();
    const nameMatch = /^([A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)*)/.exec(head);
    const fullName = `${title}${nameMatch ? nameMatch[1] : head}`.trim();

    // Capture the role word only. Running to the first full stop breaks on
    // "Aarav Deshmukh, CEO LinkedIn: linkedin.com/in/..." where that stop is
    // inside the URL, producing the role "CEO LinkedIn: linkedin".
    const roleMatch = /,\s*((?:Founder and )?(?:CEO|CTO|COO|Co-founder|Founder|Growth))\b/i.exec(value);

    return {
      ordinal: i + 1,
      token: `F${i + 1}`,
      fullName,
      role: roleMatch ? roleMatch[1].trim() : null,
      background: value,
      linkedinUrl: linkedin ? linkedin[1] : null,
    };
  });
}
