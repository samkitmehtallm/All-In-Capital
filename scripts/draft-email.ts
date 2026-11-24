/**
 * Draft the first email for one application, or for all ten.
 *
 *   pnpm draft grainkind
 *   pnpm draft --all
 *
 * The same code path the composer screen uses. Having it on the command line is
 * what makes the examples loop checkable: drafting all ten and reading them
 * together shows whether the retrieved examples are actually shaping the output,
 * which no single draft can tell you.
 */

import './load-env';

import { getStore } from '../src/lib/db/index';
import { draftForApplication } from '../src/lib/email/draft';
import { MAX_GENERATIONS, TEMPLATES, type Template } from '../src/lib/email/lint';

const args = process.argv.slice(2);
const all = args.includes('--all');
const slugArg = args.filter((a) => !a.startsWith('-')).find((a) => !(TEMPLATES as readonly string[]).includes(a));

/**
 * Force a template, overriding the recommendation.
 *
 *   pnpm draft pumpwise --template call_invite
 *
 * Needed because every one of the ten currently scores as a pass, so the
 * recommendation alone never reaches the invite path -- which is the only
 * template the examples loop and the slot placeholders apply to. Riya can
 * override the suggested template in the composer for the same reason.
 */
const templateArg = (() => {
  const i = args.indexOf('--template');
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) return undefined;
  if (!(TEMPLATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown template "${value}". One of: ${TEMPLATES.join(', ')}.`);
  }
  return value as Template;
})();

async function draftOne(slug: string) {
  const started = Date.now();
  const draft = await draftForApplication({ slug, template: templateArg });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${'='.repeat(74)}`);
  console.log(`  ${slug}  ·  ${draft.template}  ·  generation ${draft.generation} of ${MAX_GENERATIONS}`);
  console.log(
    `  ${draft.lint.wordCount} words  ·  ${draft.examplesShown} examples shown  ·  ` +
      `INR ${draft.costInr.toFixed(4)}  ·  ${seconds}s`,
  );
  console.log('='.repeat(74));
  console.log(`\n  Subject: ${draft.subject}\n`);
  console.log(
    draft.body
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );

  if (draft.lint.passed) {
    console.log('\n  Checks: all pass.');
  } else {
    console.log(`\n  Checks: ${draft.lint.failures.length} still failing after ${MAX_GENERATIONS} tries.`);
    for (const f of draft.lint.failures) console.log(`    - [${f.rule}] ${f.message}`);
  }

  return draft;
}

async function main() {
  const store = await getStore();
  const apps = await store.select<{ id: string; slug: string }>('applications');
  if (apps.length === 0) throw new Error('No applications. Run pnpm seed.');

  const targets = all
    ? apps
    : apps.filter((a) => String(a.slug) === slugArg);

  if (targets.length === 0) {
    throw new Error(
      `No application "${slugArg}". Try one of: ${apps.map((a) => a.slug).join(', ')}, or --all.`,
    );
  }

  let cost = 0;
  let passedFirstTime = 0;
  let passedEventually = 0;

  for (const app of targets) {
    const draft = await draftOne(String(app.slug));
    cost += draft.costInr;
    if (draft.generation === 1 && draft.lint.passed) passedFirstTime += 1;
    if (draft.lint.passed) passedEventually += 1;
  }

  if (targets.length > 1) {
    console.log(`\n${'='.repeat(74)}`);
    console.log(`  ${targets.length} drafts`);
    console.log(`    passed first time   ${passedFirstTime}`);
    console.log(`    passed eventually   ${passedEventually}`);
    console.log(`    still failing       ${targets.length - passedEventually}`);
    console.log(`    total cost          INR ${cost.toFixed(2)}`);
    console.log(`${'='.repeat(74)}\n`);
  } else {
    console.log('');
  }
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
