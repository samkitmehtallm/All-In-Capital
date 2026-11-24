/**
 * Seed the style examples from Riya's 60 historical emails.
 *
 *   pnpm seed:examples
 *
 * The linter decides which rows are fit to imitate, not a hard-coded list of
 * row ids. The brief plants two rows that break her standard and says to drop
 * them; if the linter cannot find them on its own, the linter is wrong, and that
 * is worth knowing at seed time rather than three drafts later.
 *
 * Each example is embedded on its situation (sector, stage, founder type,
 * traction) rather than on its prose, so retrieval finds emails written to a
 * founder in a like position instead of emails that happen to be worded alike.
 */

import './load-env';

import { readFileSync } from 'node:fs';

import { getStore } from '../src/lib/db/index';
import { loadLoop2Examples } from '../src/lib/email/examples';
import { embed } from '../src/lib/gateway/index';

const CSV_PATH = 'data/raw/B6_Loop2_Email_Export.csv';

async function main() {
  const store = await getStore();
  console.log(`\n  store: ${store.kind}`);

  const { clean, rejected } = loadLoop2Examples(readFileSync(CSV_PATH, 'utf8'));

  console.log(`\n  ${clean.length + rejected.length} emails read from the export`);
  console.log(`    ${clean.length} pass her own standard and become examples`);
  console.log(`    ${rejected.length} dropped:`);
  for (const r of rejected) console.log(`      ${r.sourceRowId}  ${r.rules.join(', ')}`);

  if (rejected.length !== 2) {
    // Not fatal, but it means the rule set drifted from the data. Say so loudly:
    // a linter that approves the boilerplate email will teach the model to write
    // boilerplate, and the drafts will look fine to it.
    console.log(
      `\n  WARNING: expected 2 planted rows to fail, got ${rejected.length}. ` +
        'Check the lint rules against the export before trusting any draft.',
    );
  }

  let written = 0;
  for (const example of clean) {
    const [vector] = await embed([example.similarityText], { step: 'seed_style_example' });
    await store.upsert(
      'style_examples',
      {
        source: 'seed_export',
        source_row_id: example.sourceRowId,
        template: example.template,
        sector: example.sector,
        stage: example.stage,
        founder_type: example.founderType,
        subject: example.subject,
        body: example.body,
        word_count: example.wordCount,
        embedding: vector,
      },
      ['source_row_id'],
    );
    written += 1;
    if (written % 10 === 0) console.log(`    embedded ${written} of ${clean.length}`);
  }

  const total = await store.count('style_examples');
  console.log(`\n  ${written} examples written. ${total} in the table.`);

  const words = clean.map((e) => e.wordCount);
  console.log(
    `  Her range: ${Math.min(...words)} to ${Math.max(...words)} words ` +
      `(median ${words.sort((a, b) => a - b)[Math.floor(words.length / 2)]}).\n`,
  );
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
