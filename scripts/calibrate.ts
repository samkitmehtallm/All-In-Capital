/**
 * Run the calibration backtest and write a Markdown report.
 *
 *   pnpm calibrate
 *
 * Scores the twelve memos blind, compares with what the fund actually did, and
 * stores the run so the Calibration screen can show it. The report is written to
 * reports/calibration-<timestamp>.md, which is what gets handed to a partner.
 */

import './load-env';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getStore } from '../src/lib/db/index';
import {
  confusion,
  explainDisagreement,
  pairAgreement,
  scoreMemoBlind,
  type BlindResult,
  type MemoRecord,
} from '../src/lib/pipeline/calibrate';

const ROOT = join(import.meta.dirname, '..');
const RUBRIC_VERSION = 1;

async function main() {
  const store = await getStore();
  console.log(`\n  store: ${store.kind}\n`);

  const memoRows = await store.select<{
    id: string;
    ordinal: number;
    company: string;
    sector: string | null;
    decision: string;
    what_it_does: string | null;
    founder_assessment: string | null;
    risks: string | null;
    why: string | null;
  }>('memos');

  if (memoRows.length === 0) throw new Error('No memos found. Run pnpm seed.');

  const memos: MemoRecord[] = memoRows
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((m) => ({
      id: String(m.id),
      ordinal: m.ordinal,
      company: m.company,
      sector: m.sector,
      decision: m.decision as 'INVESTED' | 'PASSED',
      whatItDoes: m.what_it_does ?? '',
      founderAssessment: m.founder_assessment ?? '',
      risks: m.risks ?? '',
      why: m.why ?? '',
    }));

  const results: BlindResult[] = [];
  let cost = 0;

  console.log('  Scored blind (no decision, no stage, no "why we…")\n');
  for (const memo of memos) {
    const result = await scoreMemoBlind(memo);
    cost += result.costInr;
    results.push(result);
    console.log(
      `  ${memo.company.padEnd(20)} ${result.weightedScore.toFixed(2)} ${result.ratingWord.padEnd(9)}` +
        ` system: ${(result.systemAdvances ? 'carry forward' : 'pass').padEnd(13)}` +
        ` fund: ${(result.fundAdvanced ? 'invested' : 'passed').padEnd(8)} ${result.agreed ? '✓' : '✗'}`,
    );
  }

  const agreed = results.filter((r) => r.agreed).length;
  const matrix = confusion(results);
  const pairs = pairAgreement(results);
  const pairsCorrect = pairs.filter((p) => p.correct === true).length;

  console.log(`\n  Agreement      ${agreed} of ${results.length}`);
  console.log(`  Both carry     ${matrix.bothAdvance}`);
  console.log(`  Both pass      ${matrix.bothPass}`);
  console.log(`  We missed      ${matrix.missed}   (fund invested, system would pass)`);
  console.log(`  False alarm    ${matrix.falseAlarm}   (fund passed, system would carry)`);
  console.log(`  Pair ordering  ${pairsCorrect} of ${pairs.length}\n`);

  // Explain only the disagreements. Explaining agreements would cost twelve more
  // calls to say "both agreed", which nobody reads.
  const disagreements = results.filter((r) => !r.agreed);
  const explained = new Map<string, Awaited<ReturnType<typeof explainDisagreement>>>();
  for (const result of disagreements) {
    const memo = memos.find((m) => m.id === result.memoId)!;
    const explanation = await explainDisagreement(memo, result);
    cost += explanation.costInr;
    explained.set(result.memoId, explanation);
    console.log(`  ${memo.company}`);
    console.log(`    for:     ${explanation.caseFor}`);
    console.log(`    against: ${explanation.caseAgainst}`);
  }

  // -- persist ---------------------------------------------------------------
  const [run] = await store.insert('calibration_runs', {
    rubric_version: RUBRIC_VERSION,
    agreement_n: agreed,
    agreement_d: results.length,
    confusion: matrix,
    pair_agreement: pairs,
    notes:
      'In-sample: the rubric was reconstructed from these same twelve memos, so ' +
      'this is close to a best case and is not evidence of accuracy on a new ' +
      'application. The citation rule is inert on this path because a memo has no ' +
      'extracted claims to cite.',
  });

  for (const result of results) {
    const explanation = explained.get(result.memoId);
    await store.insert('calibration_results', {
      run_id: run.id,
      memo_id: result.memoId,
      system_score: result.weightedScore,
      system_call: result.systemCall,
      fund_decision: result.fundDecision,
      agreed: result.agreed,
      case_for: explanation?.caseFor ?? null,
      case_against: explanation?.caseAgainst ?? null,
      case_sources: explanation?.sources ?? [],
    });
  }

  // -- report ----------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `calibration-${stamp}.md`);

  const lines = [
    '# Calibration backtest',
    '',
    `Run ${new Date().toISOString()} against rubric version ${RUBRIC_VERSION}.`,
    '',
    '## How far you can trust this',
    '',
    '**It is in-sample.** The rubric was reconstructed from these same twelve memos,',
    'so agreement here is close to the best case. It says the rubric encodes the',
    'reasoning the memos contain. It does **not** say the system will score a new',
    'application correctly.',
    '',
    'The citation rule is also inert here: a memo has no extracted claims to cite, so',
    'the "uncited output above 2 is rejected" guard never fires. Memo scores therefore',
    'run slightly more generous than application scores and should not be compared',
    'directly with them.',
    '',
    '## Agreement',
    '',
    `**${agreed} of ${results.length}.**`,
    '',
    '|  | Fund invested | Fund passed |',
    '|---|---|---|',
    `| System would carry forward | ${matrix.bothAdvance} | ${matrix.falseAlarm} |`,
    `| System would pass | ${matrix.missed} | ${matrix.bothPass} |`,
    '',
    `A missed company (${matrix.missed}) costs the fund a deal. A false alarm`,
    `(${matrix.falseAlarm}) costs Riya thirty minutes. They are not equally bad, and`,
    'the rubric is deliberately tuned to prefer the second.',
    '',
    '## Ranking agreement',
    '',
    `**${pairsCorrect} of ${pairs.length} pairs ordered correctly.** Each pair sets a company`,
    'the fund backed against one it passed in the same category, so this asks whether',
    'the rubric caught the distinction the partners actually drew.',
    '',
    '| Pair | Backed | Passed | Correct |',
    '|---|---|---|---|',
    ...pairs.map(
      (p) =>
        `| ${p.about} | ${p.invested} ${p.investedScore?.toFixed(2) ?? '—'} | ` +
        `${p.passed} ${p.passedScore?.toFixed(2) ?? '—'} | ${p.correct === null ? '—' : p.correct ? 'yes' : 'no'} |`,
    ),
    '',
    '## Every memo',
    '',
    '| Company | Blind score | Rating | System | Fund | Agreed |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.company} | ${r.weightedScore.toFixed(2)} | ${r.ratingWord} | ` +
        `${r.systemAdvances ? 'carry forward' : 'pass'} | ${r.fundDecision.toLowerCase()} | ${r.agreed ? 'yes' : 'no'} |`,
    ),
    '',
  ];

  if (disagreements.length > 0) {
    lines.push('## Where we disagree', '');
    for (const result of disagreements) {
      const explanation = explained.get(result.memoId);
      lines.push(
        `### ${result.company}`,
        '',
        `The fund ${result.fundDecision.toLowerCase()}; the system would ` +
          `${result.systemAdvances ? 'carry it forward' : 'pass'} at ${result.weightedScore.toFixed(2)}.`,
        '',
        `- **For carrying it forward.** ${explanation?.caseFor ?? '—'}`,
        `- **For passing.** ${explanation?.caseAgainst ?? '—'}`,
        '',
      );
      if (explanation?.sources.length) {
        lines.push(`Drawn from: ${explanation.sources.join('; ')}.`, '');
      }
    }
  } else {
    lines.push('## Where we disagree', '', 'Nowhere. Every memo matched.', '');
  }

  lines.push(
    '## What was spent',
    '',
    `INR ${cost.toFixed(4)} across ${results.length} blind scores and ${disagreements.length} explanations.`,
    '',
  );

  writeFileSync(path, lines.join('\n'));
  console.log(`\n  Report: ${path.replace(ROOT + '/', '')}`);
  console.log(`  Cost:   INR ${cost.toFixed(4)}\n`);
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
