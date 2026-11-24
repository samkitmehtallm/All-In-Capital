import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildQueryPlan, htmlToText, isAggregator } from '../src/lib/pipeline/research';

describe('query plan', () => {
  const plan = buildQueryPlan({
    company: 'GrainKind',
    oneLiner: 'Millet-based breakfast and snacks for urban families.',
    location: 'Bengaluru, Karnataka',
    sector: 'Consumer brands',
    founders: [
      { token: 'F1', fullName: 'Ritu Hegde', role: 'CEO' },
      { token: 'F2', fullName: 'Sanjay Kulkarni', role: 'COO' },
    ],
  });

  it('asks about the company, each founder, conflicts and controversies', () => {
    const intents = plan.map((p) => p.intent);
    assert.ok(intents.includes('company'));
    assert.ok(intents.includes('conflict'));
    assert.ok(intents.includes('controversy'));
    assert.equal(intents.filter((i) => i === 'founder').length, 2);
  });

  it('quotes the company name so the search is not a topic search', () => {
    assert.ok(plan.every((p) => p.query.includes('"')));
  });

  it('carries the real name in a founder query, because [F1] finds nothing', () => {
    const founderQuery = plan.find((p) => p.subjectToken === 'F1');
    assert.match(founderQuery!.query, /Ritu Hegde/);
  });

  it('never puts contact details in a query', () => {
    // The search exception permits a name and nothing else.
    for (const p of plan) {
      assert.doesNotMatch(p.query, /@/, p.query);
      assert.doesNotMatch(p.query, /linkedin\.com/i, p.query);
    }
  });

  it('is built in code, so the same application always asks the same questions', () => {
    const again = buildQueryPlan({
      company: 'GrainKind',
      oneLiner: 'Millet-based breakfast and snacks for urban families.',
      location: 'Bengaluru, Karnataka',
      sector: 'Consumer brands',
      founders: [
        { token: 'F1', fullName: 'Ritu Hegde', role: 'CEO' },
        { token: 'F2', fullName: 'Sanjay Kulkarni', role: 'COO' },
      ],
    });
    assert.deepEqual(plan, again);
  });
});

describe('primary sources beat aggregators', () => {
  it('knows the directories', () => {
    assert.equal(isAggregator('https://tracxn.com/d/companies/meetrecord'), true);
    assert.equal(isAggregator('https://www.crunchbase.com/organization/x'), true);
    assert.equal(isAggregator('https://in.linkedin.com/company/x'), false);
  });

  it('treats a publication and a company site as primary', () => {
    assert.equal(isAggregator('https://economictimes.indiatimes.com/tech/funding/x'), false);
    assert.equal(isAggregator('https://www.outdoo.ai/about-us'), false);
  });

  it('does not crash on a malformed url', () => {
    assert.equal(isAggregator('not a url'), false);
  });
});

describe('htmlToText', () => {
  it('drops script and style content rather than reading it as prose', () => {
    const html = '<p>Real text</p><script>var secret=1;</script><style>.a{color:red}</style>';
    const text = htmlToText(html);
    assert.match(text, /Real text/);
    assert.doesNotMatch(text, /secret/);
    assert.doesNotMatch(text, /color:red/);
  });

  it('unescapes entities so a quote can be matched verbatim', () => {
    assert.equal(htmlToText('<p>Tom&#39;s &amp; Jerry&quot;s</p>'), 'Tom\'s & Jerry"s');
  });
});
