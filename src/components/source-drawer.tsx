'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * "Source" link and the drawer it opens.
 *
 * The brief is explicit that no source codes appear on screen — no "d03 deck p5".
 * The link says "Source" and nothing else; the drawer is where the deck page, the
 * page number and the quote live. That is the difference between a screen a founder
 * could read over a partner's shoulder and one that looks like a database.
 */

interface SourcePayload {
  ok: boolean;
  company?: string;
  kind?: 'deck' | 'form';
  filename?: string;
  page?: number;
  pageCount?: number;
  text?: string;
  match?: { start: number; end: number } | null;
  error?: string;
}

export interface SourceRef {
  slug: string;
  kind: 'deck' | 'form';
  page: number;
  quote: string;
}

export function SourceLink({ source, label = 'Source' }: { source: SourceRef; label?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="motion-quick rounded-[6px] px-1 text-[12px] text-[var(--color-signal)] underline underline-offset-2 hover:text-[var(--color-signal-hover)]"
      >
        {label}
      </button>
      {open ? <SourceDrawer source={source} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SourceDrawer({ source, onClose }: { source: SourceRef; onClose: () => void }) {
  const [data, setData] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const params = new URLSearchParams({
        app: source.slug,
        kind: source.kind,
        page: String(source.page),
        quote: source.quote,
      });
      const response = await fetch(`/api/source?${params.toString()}`);
      const body = (await response.json()) as SourcePayload;
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not load that page.');
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that page.');
    }
  }, [source.slug, source.kind, source.page, source.quote]);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus the close button on open, and close on Escape. A drawer that traps a
  // keyboard user is worse than no drawer.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Bring the highlighted quote into view rather than making the reader hunt a
  // page of dense text for it.
  useEffect(() => {
    if (data?.match) markRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [data]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Source">
      <button
        type="button"
        aria-label="Close source"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />

      <div
        className="relative flex h-full w-full max-w-[560px] flex-col border-l border-[var(--color-hairline)] bg-[var(--color-paper)]"
        style={{ boxShadow: 'var(--shadow-float)' }}
      >
        <header className="wash flex items-start justify-between gap-3 border-b border-[var(--color-hairline)] p-4">
          <div>
            <h2 className="text-[15px] font-semibold">
              {data?.kind === 'form' ? 'Application form' : 'Pitch deck'}
              {data?.page ? (
                <span className="num ml-2 text-[12.5px] font-normal text-[var(--color-subtle)]">
                  page {data.page}
                  {data.pageCount ? ` of ${data.pageCount}` : ''}
                </span>
              ) : null}
            </h2>
            {data?.company ? (
              <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{data.company}</p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="motion-quick -mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-hairline)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            <span aria-hidden="true">✕</span>
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div className="scroll-x flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="rounded-[10px] bg-[var(--color-bad-tint)] p-3">
              <p className="text-[13px] text-[var(--color-bad)]">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 text-[12.5px] underline underline-offset-2"
              >
                Try again
              </button>
            </div>
          ) : !data ? (
            /* Skeleton matching the final layout, not a spinner. */
            <div className="space-y-2" aria-hidden="true">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-3 rounded bg-[var(--color-hairline)]"
                  style={{ width: `${70 + ((i * 13) % 30)}%` }}
                />
              ))}
            </div>
          ) : (
            <>
              {data.match === null ? (
                <p className="mb-3 rounded-[10px] bg-[var(--color-warn-tint)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
                  The quote was not found on this page. The page itself is below.
                </p>
              ) : null}

              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                {data.match && data.text ? (
                  <>
                    {data.text.slice(0, data.match.start)}
                    <span
                      ref={markRef}
                      className="rounded-[4px] bg-[var(--color-signal-quiet)] px-0.5 font-medium text-[var(--color-ink)] ring-1 ring-[var(--color-signal)]"
                    >
                      {data.text.slice(data.match.start, data.match.end)}
                    </span>
                    {data.text.slice(data.match.end)}
                  </>
                ) : (
                  data.text
                )}
              </p>
            </>
          )}
        </div>

        {data?.filename ? (
          <footer className="border-t border-[var(--color-hairline)] p-3">
            <a
              href={`/api/source/file?app=${source.slug}&kind=${source.kind}#page=${source.page}`}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-[var(--color-signal)] underline underline-offset-2"
            >
              Open the original page
            </a>
            <span className="num ml-2 text-[11.5px] text-[var(--color-subtle)]">{data.filename}</span>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
