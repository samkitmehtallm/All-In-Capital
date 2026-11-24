import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fieldValue, normaliseWhitespace, parseForm, parseFounders } from '../src/lib/ingest/form-parser';
import { extractPdf, quoteAppearsOnPage } from '../src/lib/ingest/pdf';

const RAW = join(import.meta.dirname, '..', 'data', 'raw');

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
] as const;

async function loadForm(company: string) {
  const doc = await extractPdf(join(RAW, `${company}_Form.pdf`));
  return { doc, fields: parseForm(doc.pages) };
}

describe('normaliseWhitespace', () => {
  it('flattens the one-word-per-line export into the same shape as the others', () => {
    // StockSathi's form extracts with a blank line between every word.
    const spaced = 'Company\n \nname\n \nStockSathi\n \n(StockSathi\n \nTechnologies\n \nPvt.\n \nLtd.)';
    assert.equal(normaliseWhitespace(spaced), 'Company name StockSathi (StockSathi Technologies Pvt. Ltd.)');
  });
});

describe('parseForm across all ten real applications', () => {
  it('reads the company, sector, stage and fundraising fields from every form', async () => {
    const expected: Record<string, { sector: string; stage: string; raise: string }> = {
      CAPilot: { sector: 'Fintech', stage: 'Pre-seed', raise: 'INR 1.5 Cr' },
      CareCorner: { sector: 'Other (Healthcare)', stage: 'Pre-seed', raise: 'INR 3 Cr' },
      EarnWise: { sector: 'Fintech', stage: 'Pre-seed', raise: 'INR 2 Cr' },
      GrainKind: { sector: 'Consumer brands', stage: 'Pre-seed', raise: 'INR 2.5 Cr' },
      Pumpwise: { sector: 'Deeptech', stage: 'Pre-seed', raise: 'INR 2.2 Cr' },
      RentRoute: { sector: 'Fintech', stage: 'Pre-seed', raise: 'INR 1.8 Cr' },
      Settlr: { sector: 'Fintech', stage: 'Series A', raise: 'INR 30 Cr' },
      StockSathi: { sector: 'Consumer tech', stage: 'Pre-seed', raise: 'INR 2 Cr' },
      Talkbook: { sector: 'Consumer tech', stage: 'Pre-seed', raise: 'INR 2 Cr' },
      Yatrika: { sector: 'Consumer tech', stage: 'Pre-seed', raise: 'INR 1.2 Cr' },
    };

    for (const company of COMPANIES) {
      const { fields } = await loadForm(company);
      assert.match(
        fieldValue(fields, 'Company name') ?? '',
        new RegExp(`^${company}`),
        `${company}: company name`,
      );
      assert.equal(fieldValue(fields, 'Sector (as selected)'), expected[company].sector, `${company}: sector`);
      assert.equal(fieldValue(fields, 'Stage (as selected)'), expected[company].stage, `${company}: stage`);
      assert.equal(fieldValue(fields, 'Amount raising'), expected[company].raise, `${company}: raise`);
      assert.ok(fieldValue(fields, 'Valuation expectation'), `${company}: valuation`);
    }
  });

  it('never returns a field with an empty value', async () => {
    for (const company of COMPANIES) {
      const { fields } = await loadForm(company);
      for (const f of fields) {
        assert.ok(f.value.length > 0, `${company}: ${f.label} is empty`);
      }
    }
  });

  it('does not let a section heading become a field', async () => {
    for (const company of COMPANIES) {
      const { fields } = await loadForm(company);
      const labels = fields.map((f) => f.label);
      // "Founders" must not match the label "Founder" and take the stray "s".
      assert.ok(!fields.some((f) => f.value === 's'), `${company}: heading leaked in as a field`);
      assert.deepEqual(labels, [...new Set(labels)], `${company}: duplicate labels`);
    }
  });
});

describe('parseFounders', () => {
  it('finds every founder on every form, with their LinkedIn URL intact', async () => {
    const expected: Record<string, string[]> = {
      CAPilot: ['Dhruv Shah', 'Isha Merchant'],
      CareCorner: ['Dr. Lakshmi Reddy', 'Vikram Rao'],
      // EarnWise has one founder: the co-founder left in July 2026.
      EarnWise: ['Rohit Arora'],
      GrainKind: ['Ritu Hegde', 'Sanjay Kulkarni'],
      Pumpwise: ['Karthik Subramanian', 'Neeraj Pillai'],
      RentRoute: ['Sameer Qureshi', 'Divya Menon'],
      Settlr: ['Rahul Mehta', 'Sonal Iyer'],
      StockSathi: ['Aarav Deshmukh', 'Pooja Nair'],
      Talkbook: ['Arun Kumar', 'Meenakshi S'],
      Yatrika: ['Manish Joshi', 'Kavya Nair'],
    };

    for (const company of COMPANIES) {
      const { fields } = await loadForm(company);
      const founders = parseFounders(fields);
      assert.deepEqual(
        founders.map((f) => f.fullName),
        expected[company],
        `${company}: founder names`,
      );
      for (const f of founders) {
        assert.ok(f.linkedinUrl, `${company}: ${f.token} lost its LinkedIn URL`);
        // A URL that stops at a hyphen is a PDF line break read as the end of the
        // slug. It still looks like a URL, which is why it has to be asserted.
        assert.doesNotMatch(
          f.linkedinUrl ?? '',
          /-$/,
          `${company}: ${f.token} LinkedIn URL is truncated at a line break`,
        );
        assert.match(
          f.linkedinUrl ?? '',
          /linkedin\.com\/in\/[a-z0-9-]*example$/i,
          `${company}: ${f.token} LinkedIn URL is incomplete`,
        );
      }
      assert.deepEqual(
        founders.map((f) => f.token),
        expected[company].map((_, i) => `F${i + 1}`),
        `${company}: tokens must be contiguous from F1`,
      );
    }
  });

  it('keeps a title rather than truncating the name at its full stop', async () => {
    const { fields } = await loadForm('CareCorner');
    const [first] = parseFounders(fields);
    assert.equal(first.fullName, 'Dr. Lakshmi Reddy');
  });

  it('keeps a single-letter initial', async () => {
    const { fields } = await loadForm('Talkbook');
    const founders = parseFounders(fields);
    assert.equal(founders[1].fullName, 'Meenakshi S');
  });
});

describe('quoteAppearsOnPage', () => {
  it('accepts a quote that is on the page, across the extractor line breaks', async () => {
    const deck = await extractPdf(join(RAW, 'GrainKind_Deck.pdf'));
    const marketPage = deck.pages[5];
    assert.ok(quoteAppearsOnPage('TAM INR 91,200 Cr', marketPage));
    assert.ok(quoteAppearsOnPage('38M urban households', marketPage));
  });

  it('rejects a quote that is not on the page', async () => {
    const deck = await extractPdf(join(RAW, 'GrainKind_Deck.pdf'));
    assert.equal(quoteAppearsOnPage('TAM INR 9,120 Cr', deck.pages[5]), false);
  });

  it('rejects a quote longer than 25 words as a paraphrase, not a citation', async () => {
    const deck = await extractPdf(join(RAW, 'GrainKind_Deck.pdf'));
    const long = deck.normalisedPages[5].split(' ').slice(0, 30).join(' ');
    assert.equal(quoteAppearsOnPage(long, deck.pages[5]), false);
  });
});
