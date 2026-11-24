'use client';

import { useState } from 'react';

/*
 * "Your decision" — Advance, Hold or Pass, with an OPTIONAL note.
 *
 * The note is optional on purpose. Requiring a reason makes it likelier Riya
 * records nothing at all, and a decision with no note is still the most valuable
 * signal in the system: when it goes against the recommendation, that disagreement
 * is what gets remembered and shown to the scorer next time.
 *
 * There are no per-criterion override buttons anywhere. She does not have time to
 * correct six scores, and the brief says so.
 */

type Decision = 'advance' | 'hold' | 'pass';

const OPTIONS: Array<{ value: Decision; label: string }> = [
  { value: 'advance', label: 'Advance' },
  { value: 'hold', label: 'Hold' },
  { value: 'pass', label: 'Pass' },
];

/** What the tool recommended, in the same words as the buttons. */
const RECOMMENDED_AS: Record<string, Decision> = {
  take_call: 'advance',
  dig_first: 'hold',
  pass: 'pass',
};

export function DecisionPanel({
  slug,
  company,
  recommendation,
  redCheckCount,
}: {
  slug: string;
  company: string;
  recommendation: string | null;
  redCheckCount: number;
}) {
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const recommended = recommendation ? RECOMMENDED_AS[recommendation] ?? null : null;
  const disagrees = choice !== null && recommended !== null && choice !== recommended;

  async function submit() {
    if (!choice) return;
    setState('saving');
    setMessage(null);
    try {
      const response = await fetch(`/api/applications/${slug}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: choice, note: note.trim() || null }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string; remembered?: boolean };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not save that.');
      setState('saved');
      setMessage(
        body.remembered
          ? 'Saved. Because this went against the recommendation, it will be shown on similar applications.'
          : 'Saved.',
      );
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Could not save that.');
    }
  }

  return (
    <section className="ink-panel p-4" aria-labelledby="your-decision">
      <h2 id="your-decision" className="text-[13px] font-semibold uppercase tracking-[0.08em]">
        Your decision
      </h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[#a1a1aa]">
        Nothing is advanced or rejected without this.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1.5" role="group" aria-label={`Decision on ${company}`}>
        {OPTIONS.map((option) => {
          const selected = choice === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setChoice(option.value);
                setState('idle');
                setMessage(null);
              }}
              className={`motion-quick min-h-[40px] rounded-[10px] border px-2 text-[13px] font-medium ${
                selected
                  ? 'signal-gradient border-transparent text-white'
                  : 'border-[#3f3f46] text-[#e4e4e7] hover:border-[var(--color-signal)]'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {recommended ? (
        <p className="mt-2 text-[11.5px] text-[#8b8b94]">
          We suggested <span className="text-[#e4e4e7]">{OPTIONS.find((o) => o.value === recommended)?.label}</span>
          {redCheckCount > 0 ? `, with ${redCheckCount} number${redCheckCount === 1 ? '' : 's'} that did not add up` : ''}.
        </p>
      ) : null}

      {disagrees ? (
        <p className="mt-2 rounded-[8px] bg-[#2a0a0f] px-2.5 py-2 text-[12px] leading-relaxed text-[#ffb4bc]">
          This goes against what we suggested. A line on why makes it count for the next
          similar company, but it is not required.
        </p>
      ) : null}

      <label className="mt-3 block">
        <span className="sr-only">Note, optional</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Why, in a line. Optional."
          className="w-full resize-y rounded-[10px] border border-[#3f3f46] bg-[#0a0a0b] px-2.5 py-2 text-[13px] text-[#f4f4f5] placeholder:text-[#71717a]"
        />
      </label>

      <button
        type="button"
        onClick={submit}
        disabled={!choice || state === 'saving'}
        className="motion-quick mt-2 min-h-[44px] w-full rounded-[10px] px-3 text-[13.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 signal-gradient"
      >
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Recorded' : 'Record decision'}
      </button>

      {message ? (
        <p
          role="status"
          className={`mt-2 text-[12px] leading-relaxed ${
            state === 'error' ? 'text-[#ffb4bc]' : 'text-[#a1a1aa]'
          }`}
        >
          {message}
          {state === 'error' ? (
            <button
              type="button"
              onClick={submit}
              className="ml-1.5 underline underline-offset-2 hover:text-white"
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
