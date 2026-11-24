import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DecisionPanel } from '../../../components/decision-panel';
import { EmailComposer } from '../../../components/email-composer';
import { SourceLink } from '../../../components/source-drawer';
import {
  getApplication,
  type AreaRow,
  type CheckRow,
  type ClaimRow,
} from '../../../lib/application';

/*
 * Application screen — built for a thirty-second decision.
 *
 * Order is the argument. Judgement first, then the decision itself, then the letter,
 * and only then the evidence, collapsed. Riya reads the top, decides, and sends; the
 * detail is there for the one application in ten where she wants to argue with it.
 *
 * Nothing here shows a score as a number, a model name, a cost, or a source code.
 */

export const dynamic = 'force-dynamic';

export default async function ApplicationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = await getApplication(slug);
  if (!app) notFound();

  const trippedGates = app.gates.filter((g) => g.tripped);
  const redChecks = app.checks.filter((c) => c.severity === 'red');

  return (
    <div className="space-y-5">
      <Link
        href="/"
        className="motion-quick inline-flex items-center gap-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        ← Board
      </Link>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---------------------------------------------------------------- */}
        {/* Judgement                                                         */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          <header className="wash card overflow-hidden p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-[26px] leading-tight sm:text-[30px]">{app.company}</h1>
              <span className="num text-[12.5px] text-[var(--color-subtle)]">
                {app.sector ?? 'Sector not stated'} · {app.location?.split(',')[0] ?? '—'}
              </span>
            </div>
            {app.oneLiner ? (
              <p className="mt-2 max-w-[62ch] text-[14.5px] leading-relaxed text-[var(--color-muted)]">
                {app.oneLiner}
              </p>
            ) : null}

            <p className="mt-4 border-t border-[var(--color-hairline)] pt-4 text-[17px] font-medium leading-snug">
              {app.ourTake}
            </p>
          </header>

          <section className="grid gap-4 sm:grid-cols-2">
            <Argument label="For it" body={app.forIt} />
            <Argument label="Against it" body={app.againstIt} />
          </section>

          {app.wouldChangeOurMind ? (
            <section className="card p-4">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
                What would change our mind
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed">{app.wouldChangeOurMind}</p>
            </section>
          ) : null}

          {app.remindsUsOf ? (
            <section className="card flex flex-wrap items-baseline gap-x-2 gap-y-1 p-4">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
                Reminds us of
              </h2>
              <span className="text-[14px] font-medium">{app.remindsUsOf.company}</span>
              <span
                className={`rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium ${
                  app.remindsUsOf.decision === 'INVESTED'
                    ? 'bg-[var(--color-good-tint)] text-[var(--color-good)]'
                    : 'bg-[var(--color-hairline)] text-[var(--color-muted)]'
                }`}
              >
                {app.remindsUsOf.decision === 'INVESTED' ? 'we invested' : 'we passed'}
              </span>
              <p className="mt-1 w-full text-[13px] leading-relaxed text-[var(--color-muted)]">
                {app.remindsUsOf.why.split('. ').slice(0, 2).join('. ')}
              </p>
            </section>
          ) : null}

          {/* -------------------------------------------------------------- */}
          {/* Email and meeting                                               */}
          {/* -------------------------------------------------------------- */}
          <section className="card p-5">
            <h2 className="text-[15px] font-semibold">Email and meeting</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-[10px] border border-dashed border-[var(--color-hairline)] p-4">
                <p className="text-[13px] font-medium">The letter</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-subtle)]">
                  The composer, its checks and the examples loop are not built yet. No
                  draft exists for this application, and nothing can be sent.
                </p>
              </div>

              {/*
                Shown before anything is sent, so the automatic part is understood
                BEFORE Riya clicks once, not discovered afterwards.
              */}
              <div className="rounded-[10px] border border-[var(--color-hairline)] p-4">
                <p className="text-[13px] font-medium">How the meeting gets booked</p>
                <ol className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                  <li>
                    <span className="num text-[var(--color-signal)]">1.</span> You click send. The
                    letter offers two times you are free, read from your calendar at that moment.
                  </li>
                  <li>
                    <span className="num text-[var(--color-signal)]">2.</span> If they pick one, the
                    app checks you are still free and books it with a Meet link.
                  </li>
                  <li>
                    <span className="num text-[var(--color-signal)]">3.</span> If they suggest their
                    own time, it books that when you are free, or offers two new times when you are
                    not. Anything it cannot read waits for you.
                  </li>
                </ol>
              </div>
            </div>
          </section>

          {/* -------------------------------------------------------------- */}
          {/* More detail — closed by default                                 */}
          {/* -------------------------------------------------------------- */}
          <details className="card group">
            <summary className="motion-quick flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-[14px] font-medium hover:text-[var(--color-signal)]">
              <span>More detail</span>
              <span className="num text-[12px] text-[var(--color-subtle)]">
                {app.areas.length} areas · {app.checks.length} checks · {app.claimCount} claims
                <span className="ml-2 inline-block transition-transform group-open:rotate-90">›</span>
              </span>
            </summary>

            <div className="space-y-6 border-t border-[var(--color-hairline)] p-4">
              <AreaTable areas={app.areas} />
              <CallQuestions areas={app.areas} />
              <ChecksTable checks={app.checks} slug={app.slug} />
              <Founders founders={app.founders} />
              <Evidence claims={app.claims} slug={app.slug} />
            </div>
          </details>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Decision rail                                                     */}
        {/* ---------------------------------------------------------------- */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
                Our rating
              </span>
              <span className="text-[14px] font-semibold">{app.ratingWord}</span>
            </div>
            <Meter filled={app.segments} />

            <div className="mt-4 space-y-2 border-t border-[var(--color-hairline)] pt-3">
              {trippedGates.length === 0 ? (
                <p className="text-[12.5px] text-[var(--color-muted)]">
                  No rule tripped. Nothing is waiting on a check.
                </p>
              ) : (
                trippedGates.map((gate) => (
                  <div key={gate.key}>
                    <span className="alert-chip inline-block rounded-[8px] px-2 py-1 text-[11.5px]">
                      {gate.plainName}
                    </span>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                      {gate.reason}
                    </p>
                  </div>
                ))
              )}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--color-hairline)] pt-3 text-[11.5px]">
              <Fact label="Raising" value={app.raiseDisplay} />
              <Fact label="Post-money" value={app.postMoneyDisplay} />
              <Fact label="Stage" value={app.stage ?? '—'} />
              <Fact label="Pages read" value={`${app.deckPages + app.formPages}`} />
            </dl>
          </div>

          <DecisionPanel
            slug={app.slug}
            company={app.company}
            recommendation={app.recommendation}
            redCheckCount={redChecks.length}
          />

          <EmailComposer slug={app.slug} company={app.company} />
        </aside>
      </div>
    </div>
  );
}

function Argument({ label, body }: { label: string; body: string | null }) {
  return (
    <div className="card p-4">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        {label}
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed">
        {body ?? <span className="text-[var(--color-subtle)]">Not scored yet.</span>}
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--color-subtle)]">{label}</dt>
      <dd className="num mt-0.5 text-[var(--color-ink)]">{value}</dd>
    </div>
  );
}

/** Five segments and a word. The number behind it is never printed. */
function Meter({ filled }: { filled: number }) {
  return (
    <div className="mt-2.5 flex gap-1" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`h-1.5 flex-1 rounded-full ${i <= filled ? 'meter-on' : 'meter-off'}`}
        />
      ))}
    </div>
  );
}

const CONFIDENCE_WORD: Record<string, string> = {
  high: 'confirmed outside the application',
  med: 'deck and form agree',
  low: 'deck only, or contradicted',
};

function AreaTable({ areas }: { areas: AreaRow[] }) {
  if (areas.length === 0) {
    return <p className="text-[13px] text-[var(--color-subtle)]">Not scored yet.</p>;
  }

  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        Area by area
      </h3>
      <div className="scroll-x mt-2.5">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--color-hairline)] text-left text-[11.5px] text-[var(--color-subtle)]">
              <th className="py-2 pr-3 font-medium">Area</th>
              <th className="py-2 pr-3 font-medium">Rating</th>
              <th className="py-2 font-medium">What we found</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <tr key={area.key} className="border-b border-[var(--color-hairline)] align-top">
                <td className="py-2.5 pr-3 font-medium">{area.name}</td>
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  <span title={CONFIDENCE_WORD[area.confidence]}>{area.ratingWord}</span>
                  {area.citedClaims === 0 ? (
                    <span
                      className="ml-1.5 text-[var(--color-signal)]"
                      title="Nothing in the application was cited for this area"
                    >
                      ·
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 leading-relaxed">
                  {area.plain}
                  {area.gap ? (
                    <span className="mt-1 block text-[12.5px] text-[var(--color-muted)]">
                      Missing: {area.gap}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The questions to put on the call, straight from each area's "Ask". */
function CallQuestions({ areas }: { areas: AreaRow[] }) {
  const questions = areas.filter((a) => a.ask).sort((a, b) => a.score - b.score);
  if (questions.length === 0) return null;

  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        Questions for the call
      </h3>
      <ol className="mt-2.5 space-y-2">
        {questions.map((q, i) => (
          <li key={q.key} className="flex gap-2.5 text-[13.5px] leading-relaxed">
            <span className="num shrink-0 text-[var(--color-signal)]">{i + 1}.</span>
            <span>
              {q.ask}
              <span className="ml-1.5 text-[12px] text-[var(--color-subtle)]">({q.name})</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChecksTable({ checks, slug }: { checks: CheckRow[]; slug: string }) {
  if (checks.length === 0) return null;
  const red = checks.filter((c) => c.severity === 'red');
  const rest = checks.filter((c) => c.severity !== 'red');

  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        Numbers that don&apos;t add up
      </h3>
      {red.length === 0 ? (
        <p className="mt-2 text-[13px] text-[var(--color-muted)]">
          Nothing failed to reconcile. {rest.length} check{rest.length === 1 ? '' : 's'} ran.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-2.5">
          {red.map((check) => (
            <li key={check.key} className="rounded-[10px] bg-[var(--color-bad-tint)] p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] font-semibold text-[var(--color-bad)]">
                  {check.title}
                </span>
                {check.formula ? (
                  <code className="num text-[11.5px] text-[var(--color-muted)]">{check.formula}</code>
                ) : null}
                {check.pageNumber && check.documentKind ? (
                  <SourceLink
                    source={{
                      slug,
                      kind: check.documentKind,
                      page: check.pageNumber,
                      quote: check.quote ?? '',
                    }}
                  />
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed">{check.plain}</p>
            </li>
          ))}
        </ul>
      )}

      {rest.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {rest.map((check) => (
            <li key={check.key} className="flex gap-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              <span
                className={
                  check.severity === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-subtle)]'
                }
                aria-hidden="true"
              >
                •
              </span>
              <span>{check.plain}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The evidence, each row openable at the page it came from.
 *
 * This is the only place a page number appears, and it appears inside the drawer
 * rather than on the row: the brief forbids source codes on screen, so the link
 * says "Source" and the provenance lives one click away.
 */
function Evidence({ claims, slug }: { claims: ClaimRow[]; slug: string }) {
  if (claims.length === 0) return null;
  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        What the application says
      </h3>
      <ul className="mt-2.5 divide-y divide-[var(--color-hairline)]">
        {claims.map((claim, i) => (
          <li key={`${claim.kind}-${claim.page}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
            <span className="text-[13px] font-medium">{claim.metric}</span>
            <span className="num text-[13px] text-[var(--color-muted)]">
              {claim.valueText ?? 'no number given'}
            </span>
            {claim.period ? (
              <span className="text-[11.5px] text-[var(--color-subtle)]">{claim.period}</span>
            ) : null}
            <SourceLink source={{ slug, kind: claim.kind, page: claim.page, quote: claim.quote }} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Founders({ founders }: { founders: Array<{ token: string; role: string | null; background: string }> }) {
  if (founders.length === 0) return null;
  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
        Founders
      </h3>
      <ul className="mt-2.5 space-y-2.5">
        {founders.map((f) => (
          <li key={f.token} className="text-[13px] leading-relaxed">
            {f.role ? <span className="font-medium">{f.role}. </span> : null}
            <span className="text-[var(--color-muted)]">{f.background}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[12px] text-[var(--color-subtle)]">
        Nothing here has been confirmed outside the application yet.
      </p>
    </section>
  );
}
