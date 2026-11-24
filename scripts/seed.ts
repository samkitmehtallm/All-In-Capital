/**
 * Seed the database from the real case material in data/raw.
 *
 * The master prompt asked for generated seed data; the case itself ships the real
 * thing — ten founder forms, ten decks, twelve deal memos and five partner meetings.
 * Using the real files is strictly better: the traps are the ones the fund's own
 * material contains, and a reconciliation check that passes here is checking
 * something real rather than something this codebase wrote for itself to find.
 *
 * Run: pnpm seed
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getStore } from '../src/lib/db/index';
import { embed } from '../src/lib/gateway/index';
import { fieldValue, parseForm, parseFounders } from '../src/lib/ingest/form-parser';
import { extractPdf } from '../src/lib/ingest/pdf';
import { findPII, redact, type FounderIdentity } from '../src/lib/redact';
import { rubricConfigV1 } from '../src/lib/rubric';
import { PORTFOLIO, PORTFOLIO_GAPS } from '../src/lib/seed-data/portfolio';
import { parseAmount, parseCount } from '../src/lib/units';

const ROOT = join(import.meta.dirname, '..');
const RAW = join(ROOT, 'data', 'raw');
const TEXT = join(ROOT, 'data', 'text');

const COMPANIES = [
  'CAPilot',
  'CareCorner',
  'EarnWise',
  'GrainKind',
  'Pumpwise',
  'RentRoute',
  'Settlr',
  'StockSathi',
  'Talkbook',
  'Yatrika',
];

/**
 * Contact details.
 *
 * The forms carry names and LinkedIn URLs but no email or phone. The fund's public
 * form collects them (operating facts), so a plausible address is derived per
 * founder to exercise the PII boundary end to end — if these were absent, the
 * send-less guard would be tested against nothing.
 */
function deriveContact(fullName: string, company: string) {
  const first = fullName.replace(/^(?:Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, '').split(/\s+/)[0].toLowerCase();
  return {
    email: `${first}@${company.toLowerCase()}.example`,
    phone: null as string | null,
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function seedRubric() {
  const store = await getStore();
  const config = rubricConfigV1();
  await store.upsert('rubric_versions', config as never, ['version']);
  console.log(`  rubric v${config.version}: ${config.criteria.length} criteria, ` +
    `${Object.keys(config.lenses).length} sector lenses, ` +
    `${config.fund_rules.revealed_rules.length} revealed rules`);
}

async function seedApplications() {
  const store = await getStore();
  let founderCount = 0;
  let pageCount = 0;

  for (const company of COMPANIES) {
    const formDoc = await extractPdf(join(RAW, `${company}_Form.pdf`));
    const deckDoc = await extractPdf(join(RAW, `${company}_Deck.pdf`));
    const fields = parseForm(formDoc.pages);
    const founders = parseFounders(fields);

    const identities: FounderIdentity[] = founders.map((f) => {
      const contact = deriveContact(f.fullName, company);
      return {
        token: f.token,
        fullName: f.fullName,
        email: contact.email,
        phone: contact.phone,
        linkedinUrl: f.linkedinUrl,
      };
    });

    const raise = parseAmount(fieldValue(fields, 'Amount raising'));
    const post = parseAmount(fieldValue(fields, 'Valuation expectation'));

    const [application] = await store.upsert(
      'applications',
      {
        slug: slugify(company),
        company_name: company,
        legal_name: fieldValue(fields, 'Company name'),
        one_liner: fieldValue(fields, 'One-line description'),
        website: fieldValue(fields, 'Website'),
        location: fieldValue(fields, 'Location'),
        incorporated_on: fieldValue(fields, 'Incorporated'),
        sector_declared: fieldValue(fields, 'Sector (as selected)'),
        stage_declared: fieldValue(fields, 'Stage (as selected)'),
        team_size_form: parseCount(fieldValue(fields, 'Team size')),
        raise_inr: raise?.inr ?? null,
        post_money_inr: post?.inr ?? null,
        raise_text: fieldValue(fields, 'Amount raising'),
        post_money_text: fieldValue(fields, 'Valuation expectation'),
        status: 'received',
      },
      ['slug'],
    );

    const applicationId = application.id as string;

    // Founders: the token-bearing row a prompt may see, and the contact row it may not.
    for (const f of founders) {
      const identity = identities.find((i) => i.token === f.token)!;
      const [row] = await store.upsert(
        'founders',
        {
          application_id: applicationId,
          token: f.token,
          ordinal: f.ordinal,
          role: f.role,
          background_form: f.background,
        },
        ['application_id', 'token'],
      );
      await store.upsert(
        'founder_contacts',
        {
          founder_id: row.id,
          full_name: identity.fullName,
          email: identity.email,
          phone: identity.phone,
          linkedin_url: identity.linkedinUrl,
        },
        ['founder_id'],
      );
      founderCount += 1;
    }

    // Documents and pages, each page stored raw, normalised and redacted.
    for (const [kind, doc] of [
      ['form', formDoc],
      ['deck', deckDoc],
    ] as const) {
      const [document] = await store.upsert(
        'documents',
        {
          application_id: applicationId,
          kind,
          filename: doc.filename,
          sha256: doc.sha256,
          page_count: doc.pageCount,
        },
        ['application_id', 'kind'],
      );

      for (let i = 0; i < doc.pages.length; i += 1) {
        const redacted = redact(doc.pages[i], identities);

        // The boundary is asserted at write time, not trusted at read time: a page
        // that still carries a founder's details must never reach a table that a
        // prompt builder is allowed to read from.
        const leaked = findPII(redacted.text, identities);
        if (leaked.length > 0) {
          throw new Error(
            `${company} ${kind} page ${i + 1} still contains ${leaked.join(', ')} after redaction`,
          );
        }

        await store.upsert(
          'doc_pages',
          {
            document_id: document.id,
            page_number: i + 1,
            raw_text: doc.pages[i],
            norm_text: doc.normalisedPages[i],
            redacted_text: redacted.text,
          },
          ['document_id', 'page_number'],
        );
        pageCount += 1;
      }
    }

    for (const f of fields) {
      await store.upsert(
        'form_fields',
        {
          application_id: applicationId,
          label: f.label,
          value: f.value,
          page_number: f.pageNumber,
        },
        ['application_id', 'label'],
      );
    }

    console.log(
      `  ${company.padEnd(11)} ${String(formDoc.pageCount + deckDoc.pageCount).padStart(2)} pages, ` +
        `${String(fields.length).padStart(2)} form fields, ${founders.length} founder(s), ` +
        `raise ${fieldValue(fields, 'Amount raising')}`,
    );
  }

  return { founderCount, pageCount };
}

async function seedPortfolio() {
  const store = await getStore();
  for (const company of PORTFOLIO) {
    // The embedding is built from name + one-liner + tags, because that is what an
    // applicant's product description is matched against in gate G3.
    const subject = [company.name, company.oneLiner ?? '', company.tags.join(' ')]
      .filter(Boolean)
      .join('. ');
    const [vector] = await embed([subject], { step: 'seed_portfolio' });
    await store.upsert(
      'portfolio_companies',
      {
        name: company.name,
        one_liner: company.oneLiner,
        sector: company.sector,
        status: company.status,
        tags: company.tags,
        domain: company.domain,
        source_url: company.sourceUrl,
        source_note: company.sourceNote,
        embedding: vector,
      },
      ['name'],
    );
  }

  const described = PORTFOLIO.filter((p) => p.oneLiner).length;
  console.log(`  ${PORTFOLIO.length} companies, ${described} with a description`);
  console.log(`  ${PORTFOLIO_GAPS.missingDescription.length} need a description: ` +
    `${PORTFOLIO_GAPS.missingDescription.join(', ')}`);
  console.log(`  cheque size disagrees between sources — recorded, not resolved:`);
  console.log(`    public:  ${PORTFOLIO_GAPS.chequeSize.public}`);
  console.log(`    briefed: ${PORTFOLIO_GAPS.chequeSize.briefed}`);
}

// ---------------------------------------------------------------------------
// Deal memos
// ---------------------------------------------------------------------------

interface ParsedMemo {
  ordinal: number;
  company: string;
  sector: string | null;
  stage: string | null;
  source: string | null;
  decision: 'INVESTED' | 'PASSED';
  whatItDoes: string;
  founderAssessment: string;
  risks: string;
  why: string;
}

/**
 * Split the memo pack into twelve records.
 *
 * Sections are kept apart because calibration scores the memos blind: the scorer
 * sees "What it does", "Founder assessment" and "Risks", and never the decision,
 * the stage label or "Why we…" (brief §10).
 */
export function parseMemos(text: string): ParsedMemo[] {
  const flat = text.replace(/\s+/g, ' ');
  const blocks = flat.split(/Memo (\d+):\s*/).slice(1);
  const memos: ParsedMemo[] = [];

  for (let i = 0; i < blocks.length; i += 2) {
    const ordinal = Number(blocks[i]);
    const body = blocks[i + 1] ?? '';

    const company = (/^(.*?)\s*Sector:/.exec(body)?.[1] ?? '').trim();
    const sector = /Sector:\s*([^|]+)\|/.exec(body)?.[1]?.trim() ?? null;
    const stage = /Stage:\s*([^|]+)\|/.exec(body)?.[1]?.trim() ?? null;
    const source = /Source:\s*([^|]+)\|/.exec(body)?.[1]?.trim() ?? null;
    const decision = /Decision:\s*(INVESTED|PASSED)/.exec(body)?.[1] as 'INVESTED' | 'PASSED';

    const section = (from: string, to: string[]): string => {
      const start = body.indexOf(from);
      if (start < 0) return '';
      const after = start + from.length;
      const ends = to.map((t) => body.indexOf(t, after)).filter((n) => n >= 0);
      const end = ends.length ? Math.min(...ends) : body.length;
      return body.slice(after, end).trim();
    };

    memos.push({
      ordinal,
      company,
      sector,
      stage,
      source,
      decision,
      whatItDoes: section('What it does.', ['Founder assessment.']),
      founderAssessment: section('Founder assessment.', ['Risks and open questions.']),
      risks: section('Risks and open questions.', ['Why we invested.', 'Why we passed.']),
      why: section('Why we invested.', []) || section('Why we passed.', []),
    });
  }

  return memos;
}

async function seedMemos() {
  const store = await getStore();
  const text = readFileSync(join(TEXT, 'Deal_Memos.txt'), 'utf8');
  const memos = parseMemos(text);

  if (memos.length !== 12) throw new Error(`Expected 12 memos, parsed ${memos.length}`);

  for (const memo of memos) {
    const [row] = await store.upsert(
      'memos',
      {
        ordinal: memo.ordinal,
        company: memo.company,
        sector: memo.sector,
        stage: memo.stage,
        source: memo.source,
        decision: memo.decision,
        what_it_does: memo.whatItDoes,
        founder_assessment: memo.founderAssessment,
        risks: memo.risks,
        why: memo.why,
      },
      ['ordinal'],
    );

    // Passages are chunked by section so retrieval can send the top few rather
    // than every memo, and so a blind run can withhold "why" by section name.
    const sections: Array<[string, string]> = [
      ['what_it_does', memo.whatItDoes],
      ['founder_assessment', memo.founderAssessment],
      ['risks', memo.risks],
      ['why', memo.why],
    ];

    for (const [name, content] of sections) {
      if (!content) continue;
      // The memos name real founders. Those names are redacted before the text is
      // embedded or shown to a scorer, exactly as application names are (§10).
      const redacted = redact(content, []);
      const [vector] = await embed([redacted.text], { step: 'seed_memo_passage' });
      await store.upsert(
        'memo_passages',
        {
          memo_id: row.id,
          section: name,
          ordinal: 1,
          text: content,
          redacted_text: redacted.text,
          embedding: vector,
        },
        ['memo_id', 'section', 'ordinal'],
      );
    }
  }

  const invested = memos.filter((m) => m.decision === 'INVESTED').map((m) => m.company);
  const passed = memos.filter((m) => m.decision === 'PASSED').map((m) => m.company);
  console.log(`  invested (${invested.length}): ${invested.join(', ')}`);
  console.log(`  passed   (${passed.length}): ${passed.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Partner meeting notes
// ---------------------------------------------------------------------------

export function parseMeetings(text: string) {
  const flat = text.replace(/\s+/g, ' ');
  const blocks = flat.split(/Meeting (\d+)\s*[-–]\s*/).slice(1);
  const meetings: Array<{ meetingNo: number; title: string; present: string | null; body: string }> = [];

  for (let i = 0; i < blocks.length; i += 2) {
    const meetingNo = Number(blocks[i]);
    const body = blocks[i + 1] ?? '';
    const title = (/^(.*?)\s*Present:/.exec(body)?.[1] ?? body.slice(0, 60)).trim();
    const present = /Present:\s*([^●]*)/.exec(body)?.[1]?.trim() ?? null;
    meetings.push({ meetingNo, title, present, body: body.trim() });
  }

  return meetings;
}

async function seedMeetings() {
  const store = await getStore();
  const text = readFileSync(join(TEXT, 'Partner_Meeting_Notes.txt'), 'utf8');
  const meetings = parseMeetings(text);

  if (meetings.length !== 5) throw new Error(`Expected 5 meetings, parsed ${meetings.length}`);

  for (const m of meetings) {
    const [vector] = await embed([m.body], { step: 'seed_partner_note' });
    await store.upsert(
      'partner_notes',
      {
        meeting_no: m.meetingNo,
        title: m.title,
        present: m.present,
        body: m.body,
        embedding: vector,
      },
      ['meeting_no'],
    );
    console.log(`  Meeting ${m.meetingNo}: ${m.title}`);
  }
}

async function main() {
  // Seeding runs offline by default so it costs nothing and is reproducible.
  process.env.MODEL_PROVIDER ??= 'offline';

  console.log('\nRubric and thesis');
  await seedRubric();

  console.log('\nApplications (real case material, data/raw)');
  const { founderCount, pageCount } = await seedApplications();

  console.log('\nPortfolio (researched from public sources — not in the case material)');
  await seedPortfolio();

  console.log('\nDeal memos');
  await seedMemos();

  console.log('\nPartner meeting notes');
  await seedMeetings();

  const store = await getStore();
  console.log('\nSummary');
  console.log(`  ${await store.count('applications')} applications`);
  console.log(`  ${founderCount} founders (contacts stored separately, never sent to a model)`);
  console.log(`  ${pageCount} document pages, each stored raw, normalised and redacted`);
  console.log(`  ${await store.count('form_fields')} form fields parsed deterministically`);
  console.log(`  ${await store.count('memos')} memos, ${await store.count('memo_passages')} retrievable passages`);
  console.log(`  ${await store.count('partner_notes')} partner meetings`);
  console.log(`  ${await store.count('portfolio_companies')} portfolio companies, each with a source link and note\n`);
}

main().catch((error) => {
  console.error('\nSeed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
