'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LintFailure, LintResult, Template } from '../lib/email/lint';

/*
 * The composer.
 *
 * Inline editing with autosave, five redo chips plus a free note, and a live
 * lint panel. The brief's shape, with three choices worth explaining:
 *
 *  1. **Linting runs in the browser on every keystroke, debounced, against a
 *     route that only lints.** It costs nothing and touches no database, so the
 *     panel can be genuinely live rather than updating when she stops. The save
 *     is separate and slower.
 *  2. **A failing draft is still editable and still sendable.** The panel says
 *     what is wrong; it does not lock the Send button. Riya is the decision
 *     maker, and a linter that can veto her is a linter that will eventually be
 *     wrong about something at 8pm with no way round it.
 *  3. **No version history.** Versions are saved; the brief says not to show
 *     them, and a history panel here would invite comparing drafts instead of
 *     sending one.
 *
 * The slot placeholders stay visible as placeholders. Showing invented dates in
 * a draft would be a lie about what will be sent: the real times are taken from
 * the calendar at the moment of sending.
 */

const CHIPS: Array<{ id: string; label: string }> = [
  { id: 'shorter', label: 'Shorter' },
  { id: 'warmer', label: 'Warmer' },
  { id: 'more_direct', label: 'More direct' },
  { id: 'different_opening', label: 'Different opening' },
  { id: 'sharper_question', label: 'Sharper question' },
];

const TEMPLATE_LABEL: Record<Template, string> = {
  call_invite: 'Call invite',
  dig: 'Dig first',
  pass: 'Pass',
  follow_up: 'Follow-up',
};

interface Draft {
  id: string;
  template: Template;
  subject: string;
  body: string;
  generation: number;
  lint: LintResult;
  examplesShown: number;
}

type Phase = 'idle' | 'drafting' | 'ready' | 'error';

export function EmailComposer({ slug, company }: { slug: string; company: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [lint, setLint] = useState<LintResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  // Both timers are refs, not state: changing them must never re-render, or
  // every keystroke would reschedule the render that schedules the timer.
  const lintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generate = useCallback(
    async (payload: { chip?: string; note?: string; template?: Template } = {}) => {
      setPhase('drafting');
      setError(null);
      try {
        const response = await fetch(`/api/applications/${slug}/draft`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!data.ok) {
          setError(data.error ?? 'The draft could not be written.');
          setPhase('error');
          return;
        }
        setDraft(data.draft);
        setSubject(data.draft.subject);
        setBody(data.draft.body);
        setLint(data.draft.lint);
        setSavedAt(null);
        setNote('');
        setNoteOpen(false);
        setPhase('ready');
      } catch {
        setError('The draft could not be written. Check the connection and try again.');
        setPhase('error');
      }
    },
    [slug],
  );

  // Live lint, debounced. Short enough to feel immediate, long enough that a
  // fast typist does not fire a request per character.
  useEffect(() => {
    if (!draft) return;
    if (lintTimer.current) clearTimeout(lintTimer.current);
    lintTimer.current = setTimeout(async () => {
      const response = await fetch(`/api/applications/${slug}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: draft.template, subject, body }),
      });
      const data = await response.json();
      if (data.ok) setLint(data.lint);
    }, 180);
    return () => {
      if (lintTimer.current) clearTimeout(lintTimer.current);
    };
  }, [slug, draft, subject, body]);

  // Autosave, slower, and only once she has stopped.
  useEffect(() => {
    if (!draft) return;
    if (subject === draft.subject && body === draft.body) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await fetch(`/api/applications/${slug}/draft`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id, subject, body }),
      });
      setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
    }, 900);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [slug, draft, subject, body]);

  if (phase === 'idle') {
    return (
      <section className="card p-4">
        <Header />
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
          Nothing is drafted until you ask. Writing to {company} costs one model call.
        </p>
        <button type="button" onClick={() => generate()} className="btn-signal mt-3">
          Draft the first email
        </button>
      </section>
    );
  }

  if (phase === 'drafting' && !draft) {
    return (
      <section className="card p-4">
        <Header />
        <p className="mt-2 text-[13px] text-[var(--color-muted)]">
          Writing, checking it against Riya&rsquo;s rules, and rewriting if it fails. Up to three tries.
        </p>
      </section>
    );
  }

  if (phase === 'error' && !draft) {
    return (
      <section className="card p-4">
        <Header />
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-bad)]">{error}</p>
        <button type="button" onClick={() => generate()} className="btn-quiet mt-3">
          Try again
        </button>
      </section>
    );
  }

  const failures = lint?.failures ?? [];
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <section className="card p-4">
      <Header />

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-subtle)]">
        <span>
          {draft!.generation === 1
            ? 'passed the checks first time'
            : `took ${draft!.generation} tries`}
        </span>
        {draft!.examplesShown > 0 && <span>· shown {draft!.examplesShown} of her sent emails</span>}
        {savedAt && <span>· saved {savedAt}</span>}
      </div>

      {/*
        * The template, switchable.
        *
        * The suggested one follows the recommendation, but Riya is the decision
        * maker: she may want a call with a company the system wants to pass on,
        * and that is precisely the disagreement worth capturing. Switching
        * writes a new draft, because a pass rewritten as an invite is a
        * different email, not the same one reworded.
        */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(Object.keys(TEMPLATE_LABEL) as Template[]).map((value) => {
          const active = draft!.template === value;
          return (
            <button
              key={value}
              type="button"
              disabled={phase === 'drafting'}
              onClick={() => !active && generate({ template: value })}
              aria-pressed={active}
              className={`motion-quick rounded-[var(--radius-chip)] border px-2.5 py-1 text-[12px] disabled:opacity-40 ${
                active
                  ? 'border-[var(--color-signal)] font-semibold text-[var(--color-signal)]'
                  : 'border-[var(--color-hairline)] text-[var(--color-muted)] hover:border-[var(--color-signal)]'
              }`}
            >
              {TEMPLATE_LABEL[value]}
            </button>
          );
        })}
      </div>

      <label className="mt-3 block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
          Subject
        </span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1 w-full rounded-[var(--radius-chip)] border border-[var(--color-hairline)] bg-[var(--color-paper)] px-2.5 py-1.5 text-[13.5px] outline-none focus:border-[var(--color-signal)]"
        />
      </label>

      <label className="mt-3 block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
          Body
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          spellCheck
          className="mt-1 w-full resize-y rounded-[var(--radius-chip)] border border-[var(--color-hairline)] bg-[var(--color-paper)] px-2.5 py-2 font-[var(--font-sans)] text-[13.5px] leading-relaxed outline-none focus:border-[var(--color-signal)]"
        />
      </label>

      <p className="mt-1 text-[11px] text-[var(--color-subtle)]">
        <span className="num">{words}</span> words.{' '}
        {draft!.template === 'call_invite' && (
          <>
            {'{slot_1}'} and {'{slot_2}'} stay as they are. Two free times are taken from the calendar
            when you send.
          </>
        )}
      </p>

      <LintPanel failures={failures} passed={lint?.passed ?? false} />

      <div className="mt-4 border-t border-[var(--color-hairline)] pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
          Redo
        </span>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              disabled={phase === 'drafting'}
              onClick={() => generate({ chip: chip.id })}
              className="rounded-[var(--radius-chip)] border border-[var(--color-hairline)] px-2.5 py-1 text-[12px] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] disabled:opacity-40"
            >
              {chip.label}
            </button>
          ))}
          <button
            type="button"
            disabled={phase === 'drafting'}
            onClick={() => setNoteOpen((open) => !open)}
            className="rounded-[var(--radius-chip)] border border-dashed border-[var(--color-hairline)] px-2.5 py-1 text-[12px] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] disabled:opacity-40"
          >
            Redo with a note
          </button>
        </div>

        {noteOpen && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) generate({ note: note.trim() });
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Mention the NBFC partner, and ask about first-loss"
              maxLength={300}
              className="flex-1 rounded-[var(--radius-chip)] border border-[var(--color-hairline)] bg-[var(--color-paper)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-signal)]"
            />
            <button type="submit" disabled={!note.trim() || phase === 'drafting'} className="btn-quiet">
              Redo
            </button>
          </form>
        )}

        {phase === 'drafting' && (
          <p className="mt-2 text-[11.5px] text-[var(--color-subtle)]">Rewriting&hellip;</p>
        )}
        {error && <p className="mt-2 text-[11.5px] text-[var(--color-bad)]">{error}</p>}
      </div>

      <div className="mt-4 border-t border-[var(--color-hairline)] pt-3">
        <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">
          Sending is not built yet. When it is, &ldquo;Review and send&rdquo; will pick your two free
          times, name the recipient and both times, and send on one click.
        </p>
      </div>
    </section>
  );
}

function Header() {
  return (
    <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
      First email
    </h2>
  );
}

/**
 * The live checks panel.
 *
 * Status is carried by the word and the icon, never by hue alone: the palette is
 * red, black and white, so a red-for-fail convention would be indistinguishable
 * from the accent used everywhere else.
 */
function LintPanel({ failures, passed }: { failures: LintFailure[]; passed: boolean }) {
  return (
    <div className="mt-3 rounded-[var(--radius-chip)] border border-[var(--color-hairline)] bg-[var(--color-card)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-subtle)]">
          Live checks
        </span>
        <span className={`text-[12px] font-semibold ${passed ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}`}>
          {passed ? 'All checks pass' : `${failures.length} to fix`}
        </span>
      </div>

      {passed ? (
        <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">
          Matches her standard: length, one number up front, one question, two times, no banned
          wording.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {failures.map((failure) => (
            <li key={`${failure.rule}-${failure.message}`} className="text-[12px] leading-snug">
              <span className="font-semibold text-[var(--color-ink)]">{failure.message}</span>{' '}
              <span className="text-[var(--color-muted)]">{failure.fix}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
