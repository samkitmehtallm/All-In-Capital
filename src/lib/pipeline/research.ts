/**
 * Pipeline step 4 — research.
 *
 * "Half of what this system needs to know about an applicant isn't sitting in our
 * files. It's scattered across the internet. I want it to go find that, not just
 * read what the founder chose to put in the deck." — Kushal.
 *
 * Four properties the brief asks for, and how each is met:
 *
 *  1. **A query plan in code.** `buildQueryPlan` is a pure function. The set of
 *     questions asked about an applicant is not a model's choice.
 *  2. **One small extraction call per page, which must quote the page.** Same
 *     verbatim rule as claim extraction: a quote that is not on the page is dropped.
 *  3. **Primary sources beat aggregators.** Ranked by domain, with the reasoning in
 *     `AGGREGATOR_DOMAINS`.
 *  4. **Same-name, different-person results are set aside.** Not discarded silently
 *     — recorded with the reason, because "we found a different Ritu Hegde" is
 *     information and "we found nothing" is a different thing to tell Riya.
 *
 * ## The name problem
 *
 * A founder's name must reach a search engine or there is no research. It must NOT
 * reach a model (§2.3). Both hold here: `searchWeb` carries the name under the
 * narrow search-query exception, and every fetched page is redacted to [F1] before
 * extraction. Whether the name appeared on the page BEFORE redaction is kept as a
 * signal, because a page that never mentions them is weak evidence about them.
 */

import { z } from 'zod';

import { callModel, searchWeb } from '../gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../gateway/guards';
import { redact, type FounderIdentity } from '../redact';

export type QueryIntent = 'company' | 'founder' | 'conflict' | 'controversy';

export interface PlannedQuery {
  intent: QueryIntent;
  /** The token this query is about, where it is about a person. */
  subjectToken: string | null;
  query: string;
}

/**
 * Aggregators and directories.
 *
 * Useful for existence and funding, poor for anything about a founder: they
 * restate each other and a mistake propagates across all of them. A primary source
 * is the company's own site, a regulator, or a named publication's reporting.
 */
const AGGREGATOR_DOMAINS = [
  'tracxn.com',
  'crunchbase.com',
  'pitchbook.com',
  'owler.com',
  'zaubacorp.com',
  'cbinsights.com',
  'growjo.com',
  'leadiq.com',
  'rocketreach.co',
  'signalhire.com',
  'apollo.io',
];

/**
 * Country-code domains that indicate a market other than India.
 *
 * Not exhaustive and not meant to be: it is a backstop for the common case where a
 * same-named company in another country gets reported as a match. An Indian company
 * covered on a .com stays in scope, which is the right default.
 */
const FOREIGN_CCTLDS = [
  '.id', '.co.id', '.my', '.sg', '.ph', '.vn', '.th', '.pk', '.bd', '.lk',
  '.au', '.nz', '.za', '.ng', '.ke', '.br', '.mx', '.ru', '.cn', '.jp', '.kr',
];

export function isAggregator(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return AGGREGATOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export interface QueryPlanInput {
  company: string;
  oneLiner: string | null;
  location: string | null;
  sector: string | null;
  founders: Array<{ token: string; fullName: string; role: string | null }>;
}

/**
 * The questions asked about every applicant.
 *
 * Deliberately short. Each query costs a search, searches are the most expensive
 * call in the pipeline, and a long tail of speculative queries buys noise.
 */
export function buildQueryPlan(input: QueryPlanInput): PlannedQuery[] {
  const city = input.location?.split(',')[0]?.trim() ?? '';
  const plan: PlannedQuery[] = [];

  plan.push({
    intent: 'company',
    subjectToken: null,
    query: `"${input.company}" ${input.sector ?? ''} startup ${city} India`.replace(/\s+/g, ' ').trim(),
  });

  for (const founder of input.founders) {
    plan.push({
      intent: 'founder',
      subjectToken: founder.token,
      query: `"${founder.fullName}" ${input.company} ${founder.role ?? 'founder'}`.replace(/\s+/g, ' ').trim(),
    });
  }

  // Conflicts and controversies are asked separately, because a query that mixes
  // "funding" and "fraud" returns neither well.
  plan.push({
    intent: 'conflict',
    subjectToken: null,
    query: `"${input.company}" competitor OR acquisition OR "same space" India`,
  });
  plan.push({
    intent: 'controversy',
    subjectToken: null,
    query: `"${input.company}" lawsuit OR investigation OR complaint OR shut down`,
  });

  return plan;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Strip a fetched page to readable text. No library: this is a cheap reduction. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPageText(url: string, timeoutMs = 12_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Identify the fetcher honestly rather than impersonating a browser.
        'user-agent': 'AllInCapital-Research/1.0 (+inbound triage; contact the fund)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) return null;
    const html = await response.text();
    return htmlToText(html).slice(0, 14_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const FindingSchema = z.object({
  /** Does this page describe the same company or person as the application? */
  entity_match: z.enum(['same', 'different', 'unclear']),
  /** Why, in one line. Used verbatim as the set-aside reason. */
  entity_reason: z.string().min(1),
  /** What the page confirms, in one line. Null when it confirms nothing. */
  confirms: z.string().nullable(),
  /** Copied from the page. Must appear on it. */
  quote: z.string().nullable(),
});

const FINDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entity_match', 'entity_reason', 'confirms', 'quote'],
  properties: {
    entity_match: { type: 'string', enum: ['same', 'different', 'unclear'] },
    entity_reason: { type: 'string' },
    confirms: { type: ['string', 'null'] },
    quote: { type: ['string', 'null'] },
  },
} as const;

const EXTRACT_SYSTEM = `You are checking whether one web page says anything about a
specific company or founder from a funding application.

The hard part is identity, so do that first. Many pages mention a similarly named
company or a different person with the same name. Decide:
- "same" only if details line up: the company, the role, the city, the dates.
- "different" if it is a similarly named but separate company or person. Say which.
- "unclear" if you genuinely cannot tell.

COUNTRY IS DECISIVE. If the page describes a company operating in a different
country from the one in the application, it is "different", however exactly the
name matches. A company of the same name in another market is a different company.

Then, only if it is "same", say in one line what the page confirms, and copy a quote
from the page that supports it, character for character, under 25 words. If the page
confirms nothing about them, set confirms and quote to null.

Founder names appear as [F1], [F2] in both the application and the page text. Judge
identity from role, company, place and dates, not from the name.

${DATA_NOT_INSTRUCTIONS}`;

export interface Finding {
  url: string;
  domain: string;
  title: string;
  isPrimarySource: boolean;
  entityMatch: 'same' | 'different' | 'unclear';
  confirms: string | null;
  quote: string | null;
  quoteVerified: boolean;
  setAsideReason: string | null;
  /** Did the founder's real name appear on the page before redaction? */
  nameOnPage: boolean;
}

export async function extractFinding(input: {
  url: string;
  title: string;
  pageText: string;
  company: string;
  subjectDescription: string;
  founders: FounderIdentity[];
  applicationId: string;
  traceId?: string;
}): Promise<{ finding: Finding; costInr: number }> {
  const domain = (() => {
    try {
      return new URL(input.url).hostname.replace(/^www\./, '');
    } catch {
      return input.url;
    }
  })();

  // Whether the name is present is a signal; the name itself does not go onward.
  const nameOnPage = input.founders.some(
    (f) => f.fullName && new RegExp(`\\b${f.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(input.pageText),
  );
  // The page text is not the only thing that carries a name. A search-result title
  // routinely does ("Ritu Hegde, founder of..."), and so can a URL slug. The guard
  // caught exactly this. Everything that goes into the prompt is redacted, not just
  // the part that looked like the risky one.
  const redactedPage = redact(input.pageText, input.founders).text;
  const redactedTitle = redact(input.title, input.founders).text;

  const response = await callModel({
    step: 'research:extract',
    system: EXTRACT_SYSTEM,
    user:
      `From the application:\n${input.subjectDescription}\n\n` +
      `Page title: ${redactedTitle}\nPage domain: ${domain}\n\n` +
      `Page text:\n${redactedPage}`,
    temperature: 0,
    responseSchema: FINDING_JSON_SCHEMA,
    founders: input.founders,
    applicationId: input.applicationId,
    traceId: input.traceId,
  });

  const parsed = FindingSchema.safeParse(response.json);

  if (!parsed.success) {
    return {
      finding: {
        url: input.url,
        domain,
        title: input.title,
        isPrimarySource: !isAggregator(input.url),
        entityMatch: 'unclear',
        confirms: null,
        quote: null,
        quoteVerified: false,
        setAsideReason: 'The page could not be read reliably.',
        nameOnPage,
      },
      costInr: response.costInr,
    };
  }

  const out = parsed.data;
  // Verified against the REDACTED page, which is what the model was shown. Checking
  // against the original would let a quote containing a name pass as verbatim when
  // the model never saw that name.
  const quoteVerified =
    out.quote !== null &&
    out.quote.trim().split(/\s+/).length <= 25 &&
    redactedPage.toLowerCase().includes(out.quote.trim().toLowerCase());

  // Deterministic backstop on country.
  //
  // The model marked four Indonesian pages about "GrainKind", a brand of PT Inti
  // Food Sejahtera, as the same company as a Bengaluru millet startup, because the
  // name and the category matched. Telling Riya a company is "confirmed externally"
  // when the confirmation is about a different company in another market is the
  // worst failure this step can produce, so the prompt is not trusted alone.
  const foreignDomain = FOREIGN_CCTLDS.some((tld) => domain.endsWith(tld));
  const countryMismatch = foreignDomain && /india|bengaluru|mumbai|delhi|hyderabad|chennai|pune|jaipur|gurugram|ahmedabad/i.test(input.subjectDescription);

  const setAside =
    countryMismatch && out.entity_match === 'same'
      ? `Published on a ${domain} site, which covers a different market from this application. Treated as a different company of the same name.`
      : out.entity_match === 'same'
      ? null
      : out.entity_match === 'different'
        ? `A different company or person: ${out.entity_reason}`
        : `Could not confirm this is the same company or person: ${out.entity_reason}`;

  return {
    finding: {
      url: input.url,
      domain,
      title: input.title,
      isPrimarySource: !isAggregator(input.url),
      entityMatch: countryMismatch && out.entity_match === 'same' ? 'different' : out.entity_match,
      // An unverified quote means the claim behind it is unsupported, so both go.
      confirms: out.entity_match === 'same' && quoteVerified && !countryMismatch ? out.confirms : null,
      quote: quoteVerified ? out.quote : null,
      quoteVerified,
      setAsideReason:
        setAside ??
        (out.quote !== null && !quoteVerified
          ? 'The quote offered was not on the page.'
          : null),
      nameOnPage,
    },
    costInr: response.costInr,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ResearchOutcome {
  queries: Array<{ intent: QueryIntent; subjectToken: string | null; query: string; resultCount: number; wasEmpty: boolean }>;
  findings: Finding[];
  /** Findings that survived identity and quote checks. */
  confirmed: Finding[];
  setAside: Finding[];
  costInr: number;
}

export async function research(input: {
  applicationId: string;
  plan: PlannedQuery[];
  company: string;
  subjectDescription: string;
  founders: FounderIdentity[];
  traceId?: string;
  maxPagesPerQuery?: number;
}): Promise<ResearchOutcome> {
  const maxPages = input.maxPagesPerQuery ?? 2;
  const queries: ResearchOutcome['queries'] = [];
  const findings: Finding[] = [];
  let costInr = 0;
  const seenUrls = new Set<string>();

  for (const planned of input.plan) {
    const { hits, costInr: searchCost } = await searchWeb({
      step: `research:search:${planned.intent}`,
      query: planned.query,
      applicationId: input.applicationId,
      traceId: input.traceId,
    });
    costInr += searchCost;

    // Logged whether or not it found anything. An empty query is the finding that
    // nothing could be confirmed, and the brief asks for it explicitly.
    queries.push({
      intent: planned.intent,
      subjectToken: planned.subjectToken,
      query: planned.query,
      resultCount: hits.length,
      wasEmpty: hits.length === 0,
    });

    // Primary sources first, so the page budget is spent on them rather than on
    // three directories restating each other.
    const ordered = [...hits].sort(
      (a, b) => Number(isAggregator(a.url)) - Number(isAggregator(b.url)),
    );

    let fetched = 0;
    for (const hit of ordered) {
      if (fetched >= maxPages) break;
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);

      const pageText = await fetchPageText(hit.url);
      if (!pageText || pageText.length < 200) continue;
      fetched += 1;

      const { finding, costInr: extractCost } = await extractFinding({
        url: hit.url,
        title: hit.title,
        pageText,
        company: input.company,
        subjectDescription: input.subjectDescription,
        founders: input.founders,
        applicationId: input.applicationId,
        traceId: input.traceId,
      });
      costInr += extractCost;
      findings.push(finding);
    }
  }

  return {
    queries,
    findings,
    confirmed: findings.filter((f) => f.entityMatch === 'same' && f.quoteVerified),
    setAside: findings.filter((f) => f.setAsideReason !== null),
    costInr,
  };
}
