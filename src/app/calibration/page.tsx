import { getStore } from '../../lib/db/index';

/*
 * Calibration.
 *
 * Kushal's actual request: "Run it against those and tell me how often it
 * disagrees with us. When it does, tell me whether we were wrong or it was."
 *
 * So this screen leads with the number, says what the number is worth, and does
 * not flatter it. An agreement figure that comes from agreeing with every pass is
 * reported as exactly that, because a partner who discovers it himself stops
 * trusting the whole tool.
 */

export const dynamic = 'force-dynamic';

interface ConfusionShape {
  bothAdvance?: number;
  missed?: number;
  falseAlarm?: number;
  bothPass?: number;
}

interface PairShape {
  about: string;
  invested: string;
  passed: string;
  investedScore: number | null;
  passedScore: number | null;
  correct: boolean | null;
}

export default async function CalibrationPage() {
  const store = await getStore();

  const runs = await store.select<{
    id: string;
    rubric_version: number;
    agreement_n: number;
    agreement_d: number;
    confusion: ConfusionShape;
    pair_agreement: PairShape[];
    notes: string | null;
    created_at: string;
  }>('calibration_runs');

  if (runs.length === 0) {
    return (
      <div className="card p-6">
        <h1 className="text-[22px]">Calibration has not been run.</h1>
        <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-[var(--color-muted)]">
          Scoring the twelve past decisions blind is how you find out how far this can
          be trusted. Run <code className="num">pnpm calibrate</code>.
        </p>
      </div>
    );
  }

  const run = [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  const results = await store.select<{
    memo_id: string;
    system_score: number;
    system_call: string;
    fund_decision: string;
    agreed: boolean;
    case_for: string | null;
    case_against: string | null;
  }>('calibration_results', { run_id: run.id });

  const memos = await store.select<{ id: string; company: string; sector: string | null }>('memos');
  const companyFor = (id: string) => memos.find((m) => String(m.id) === String(id))?.company ?? '—';

  const matrix = run.confusion ?? {};
  const bothAdvance = matrix.bothAdvance ?? 0;
  const missed = matrix.missed ?? 0;
  const falseAlarm = matrix.falseAlarm ?? 0;
  const bothPass = matrix.bothPass ?? 0;

  const pairs = Array.isArray(run.pair_agreement) ? run.pair_agreement : [];
  const pairsCorrect = pairs.filter((p) => p.correct === true).length;

  // The agreement number on its own can be an artefact. If every agreement sits in
  // one cell, say so on the screen rather than letting the headline imply skill.
  const carriedAnything = bothAdvance + falseAlarm > 0;
  const rows = [...results].sort((a, b) => Number(b.system_score) - Number(a.system_score));
  const disagreements = rows.filter((r) => !r.agreed);

  return (
    <div className="space-y-6">
      <header className="wash card p-5">
        <h1 className="text-[24px] leading-tight sm:text-[28px]">
          We agree with {run.agreement_n} of {run.agreement_d} past decisions.
        </h1>
        <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-[var(--color-muted)]">
          Each of the twelve past decisions was scored blind: what the company does, the
          founder assessment and the risks, with names removed. Never the outcome, never
          the stage, never &ldquo;why we invested&rdquo;.
        </p>

        {!carriedAnything ? (
          <p className="alert-chip mt-4 rounded-[10px] px-3 py-2.5 text-[13px] leading-relaxed">
            Read this before the number above. The system would have passed on all{' '}
            {run.agreement_d}, so every agreement is an agreement with a pass and every
            miss is a company the fund backed. Always answering &ldquo;pass&rdquo; scores{' '}
            {bothPass} of {run.agreement_d} on this pack, so the headline is not evidence
            of judgement. The ordering below is.
          </p>
        ) : null}
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-[15px] font-semibold">Where the agreement sits</h2>
          <div className="scroll-x mt-3">
            <table className="w-full min-w-[380px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[11.5px] text-[var(--color-subtle)]">
                  <th className="py-2 pr-3 font-medium" />
                  <th className="py-2 pr-3 font-medium">Fund invested</th>
                  <th className="py-2 font-medium">Fund passed</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-[var(--color-hairline)]">
                  <th scope="row" className="py-3 pr-3 text-left font-medium">
                    We would carry forward
                  </th>
                  <Cell value={bothAdvance} good />
                  <Cell value={falseAlarm} />
                </tr>
                <tr className="border-t border-[var(--color-hairline)]">
                  <th scope="row" className="py-3 pr-3 text-left font-medium">
                    We would pass
                  </th>
                  <Cell value={missed} bad />
                  <Cell value={bothPass} good />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            A missed company costs the fund a deal. A false alarm costs Riya half an
            hour. They are not equally bad, and the rubric is meant to prefer the second.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-[15px] font-semibold">
            Ranking agreement: {pairsCorrect} of {pairs.length}
          </h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            Each pair sets a company the fund backed against one it passed in the same
            category. This asks whether the rubric caught the distinction the partners
            actually drew, which the agreement number cannot.
          </p>
          <ul className="mt-3 space-y-2">
            {pairs.map((pair) => (
              <li key={`${pair.invested}-${pair.passed}`} className="flex items-baseline gap-2 text-[13px]">
                <span
                  className={`shrink-0 text-[13px] ${pair.correct ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}`}
                  aria-hidden="true"
                >
                  {pair.correct ? '✓' : '✗'}
                </span>
                <span>
                  <span className="font-medium">{pair.invested}</span>
                  <span className="num mx-1 text-[var(--color-subtle)]">
                    {pair.investedScore?.toFixed(2) ?? '—'}
                  </span>
                  over <span className="font-medium">{pair.passed}</span>
                  <span className="num mx-1 text-[var(--color-subtle)]">
                    {pair.passedScore?.toFixed(2) ?? '—'}
                  </span>
                  <span className="block text-[11.5px] text-[var(--color-subtle)]">{pair.about}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold">Every past decision</h2>
        <div className="scroll-x mt-3">
          <table className="w-full min-w-[620px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-hairline)] text-left text-[11.5px] text-[var(--color-subtle)]">
                <th className="py-2 pr-3 font-medium">Company</th>
                <th className="py-2 pr-3 font-medium">Blind score</th>
                <th className="py-2 pr-3 font-medium">We would</th>
                <th className="py-2 pr-3 font-medium">The fund</th>
                <th className="py-2 font-medium">Agreed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.memo_id} className="border-b border-[var(--color-hairline)]">
                  <td className="py-2.5 pr-3 font-medium">{companyFor(row.memo_id)}</td>
                  <td className="num py-2.5 pr-3">{Number(row.system_score).toFixed(2)}</td>
                  <td className="py-2.5 pr-3">{row.system_call === 'pass' ? 'pass' : 'carry forward'}</td>
                  <td className="py-2.5 pr-3">{row.fund_decision.toLowerCase()}</td>
                  <td className="py-2.5">
                    <span className={row.agreed ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}>
                      {row.agreed ? 'yes' : 'no'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {disagreements.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold">Where we disagree</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {disagreements.map((row) => (
              <article key={row.memo_id} className="card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[14px] font-semibold">{companyFor(row.memo_id)}</h3>
                  <span className="text-[11.5px] text-[var(--color-subtle)]">
                    the fund {row.fund_decision.toLowerCase()}; we would{' '}
                    {row.system_call === 'pass' ? 'pass' : 'carry forward'}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed">
                  <span className="font-medium text-[var(--color-good)]">For. </span>
                  {row.case_for ?? '—'}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed">
                  <span className="font-medium text-[var(--color-bad)]">Against. </span>
                  {row.case_against ?? '—'}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {run.notes ? (
        <section className="card p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
            How far this goes
          </h2>
          <p className="mt-2 max-w-[75ch] text-[13.5px] leading-relaxed text-[var(--color-muted)]">
            {run.notes}
          </p>
          <p className="mt-2 text-[12.5px] text-[var(--color-subtle)]">
            Re-run with <code className="num">pnpm calibrate</code>. The run cost is not
            shown here on purpose.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Cell({ value, good, bad }: { value: number; good?: boolean; bad?: boolean }) {
  return (
    <td className="py-3 pr-3">
      <span
        className={`num text-[18px] font-semibold ${
          bad && value > 0
            ? 'text-[var(--color-bad)]'
            : good && value > 0
              ? 'text-[var(--color-good)]'
              : 'text-[var(--color-muted)]'
        }`}
      >
        {value}
      </span>
    </td>
  );
}
