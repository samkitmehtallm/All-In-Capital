/**
 * Derive the recommendation thresholds from the calibration run.
 *
 *   pnpm thresholds           # report only, changes nothing
 *   pnpm thresholds --apply   # write a new rubric version
 *
 * The brief's thresholds (7.5 to take the call, 6.0 to dig first) were written for
 * a notional 0-10 scale. The scorer's actual range on this material is roughly
 * 1.8 to 7.0, so nothing ever reached 7.5 and the top lane could never fill. That
 * is a scale problem, not a judgement problem: ranking agreement was 6 of 6.
 *
 * This finds the boundary that separates what the fund backed from what it passed,
 * cross-validates it leave-one-pair-out, and writes the result as rubric version 2
 * rather than editing version 1 in place — every score records the version it used,
 * and rewriting a version would make old scores unexplainable.
 */

import './load-env';

import { getStore } from '../src/lib/db/index';
import {
  crossValidateThreshold,
  deriveThreshold,
  TEACHING_PAIRS,
  type BlindResult,
} from '../src/lib/pipeline/calibrate';
import { rubricConfigV1, THRESHOLDS } from '../src/lib/rubric';

const apply = process.argv.includes('--apply');

async function main() {
  const store = await getStore();

  const runs = await store.select<{ id: string; created_at: string }>('calibration_runs');
  if (runs.length === 0) throw new Error('No calibration run found. Run pnpm calibrate first.');
  const run = [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  const rows = await store.select<{
    memo_id: string;
    system_score: number;
    fund_decision: string;
  }>('calibration_results', { run_id: run.id });
  const memos = await store.select<{ id: string; company: string }>('memos');
  const companyFor = (id: string) => memos.find((m) => String(m.id) === String(id))?.company ?? '—';

  const results: BlindResult[] = rows.map((r) => ({
    memoId: String(r.memo_id),
    company: companyFor(String(r.memo_id)),
    fundDecision: r.fund_decision as 'INVESTED' | 'PASSED',
    weightedScore: Number(r.system_score),
    ratingWord: '',
    systemCall: 'pass',
    systemAdvances: false,
    fundAdvanced: r.fund_decision === 'INVESTED',
    agreed: false,
    costInr: 0,
  }));

  const samples = results.map((r) => ({ score: r.weightedScore, advanced: r.fundAdvanced }));
  const fit = deriveThreshold(samples);
  const cv = crossValidateThreshold(results);

  console.log('\n  Scores by what the fund actually did\n');
  for (const r of [...results].sort((a, b) => b.weightedScore - a.weightedScore)) {
    console.log(
      `  ${r.weightedScore.toFixed(2).padStart(5)}  ${r.fundAdvanced ? 'invested' : 'passed  '}  ${r.company}`,
    );
  }

  console.log(`\n  Highest passed      ${fit.highestPassed?.toFixed(2) ?? '—'}`);
  console.log(`  Lowest invested     ${fit.lowestAdvanced?.toFixed(2) ?? '—'}`);
  console.log(`  Gap between them    ${fit.margin.toFixed(2)}${fit.margin > 0 ? '  (classes separate cleanly)' : '  (classes overlap)'}`);
  console.log(`  Derived boundary    ${fit.boundary.toFixed(2)}`);
  console.log(`  In-sample           ${fit.correct} of ${fit.total}`);

  console.log(`\n  Leave-one-pair-out  ${cv.correct} of ${cv.total}\n`);
  for (const fold of cv.folds) {
    console.log(
      `    held out ${fold.heldOut.padEnd(34)} boundary ${fold.boundary.toFixed(2)}  ` +
        `${fold.correct}/${fold.total}`,
    );
  }

  // The boundary separates pass from carry-forward. "Take the call" needs to sit
  // above it with room for "dig first" in between, so it goes at the midpoint
  // between the boundary and the highest score actually observed. Putting it at the
  // top of the range would make the lane unreachable all over again.
  const topScore = Math.max(...results.map((r) => r.weightedScore));
  const digFirst = fit.boundary;
  const takeCall = Math.round(((fit.boundary + topScore) / 2) * 100) / 100;

  console.log(`\n  Proposed thresholds`);
  console.log(`    dig first   ${THRESHOLDS.digFirst.toFixed(2)} -> ${digFirst.toFixed(2)}`);
  console.log(`    take call   ${THRESHOLDS.takeCall.toFixed(2)} -> ${takeCall.toFixed(2)}`);
  console.log(`    (highest score observed: ${topScore.toFixed(2)})`);

  const advanced = results.filter((r) => r.weightedScore >= digFirst);
  const wouldTakeCall = results.filter((r) => r.weightedScore >= takeCall);
  console.log(
    `\n  Under these: ${advanced.length} carried forward, of which ${wouldTakeCall.length} worth a call.`,
  );

  if (!apply) {
    console.log('\n  Nothing written. Re-run with --apply to create rubric version 2.\n');
    return;
  }

  const base = rubricConfigV1();
  const next = {
    ...base,
    version: 2,
    label: `Thresholds derived from the ${results.length}-memo calibration backtest`,
    thresholds: { takeCall, digFirst },
    is_active: true,
  };

  // Only one version may be active. Stand the old one down first.
  await store.update('rubric_versions', { version: 1 }, { is_active: false });
  await store.upsert('rubric_versions', next as never, ['version']);

  console.log('\n  Wrote rubric version 2 and made it active. Version 1 is kept.');
  console.log('  Re-run `pnpm pipeline --recheck` to re-lane the board against it.\n');
  console.log(`  Pairs used for cross-validation: ${TEACHING_PAIRS.length}\n`);
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
