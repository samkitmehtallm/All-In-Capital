# All In Capital — inbound triage

An internal tool for a pre-seed venture fund in India. It reads each founder
application, checks the numbers, researches the founders, applies the fund's rules,
scores it against the thesis, ranks it into lanes, and drafts the first email.

Riya, the fund's associate, decides: Advance, Hold or Pass, with an optional note.
**Nothing is advanced or rejected automatically, and she clicks the first send.**
After that one click the tool books the meeting on its own — it offers two free times
from her calendar, reads the reply, and books the call. It may send only two kinds of
message by itself, both in the same thread: a booking confirmation for a time she is
free for, and an offer of two new times when the founder's suggestion clashes.
Anything it cannot read waits for her.

Built for MESA PGP Cohort 4, Term 2 (Cases 3, 4 and 5).

---

## Why it exists

About 100 applications arrive each month. Riya, the fund's associate, screens them in
the evening at roughly 30 minutes each — more than nineteen working days a quarter,
most of it on applications that were never going to pass. The partner's ask was not
"decide for me":

> I'm not asking it to decide. I'm asking it to make the case and show its work. If
> it tells me a company is a seven out of ten and can't tell me which part of our
> thesis it's scoring against, that's worse than useless. I'll stop trusting it and I
> won't be able to say when.
> — Kushal Bhagia, co-founder

So every claim on every screen traces to a deck page, a form field or a web page, and
every gap is named rather than quietly filled in.

## Non-negotiables

These are enforced by tests, not by convention.

| Rule | How it is enforced |
|---|---|
| Arithmetic happens in code, never in a model | `src/lib/units.ts`, `src/lib/market-math.ts`, with unit tests over every market slide in all ten decks |
| Founder names, emails, phones and LinkedIn URLs never reach a model | `assertSendLess` **throws**; asserted again on all 116 pages at seed time |
| Every system prompt ends with the data-not-instructions sentence | `assertDataGuard` throws if a step forgets it |
| One module may call a model | `tests/gateway-is-the-only-caller.test.ts` walks `src/` and fails if anything else imports a provider SDK |
| A tripped rule flags, never auto-rejects | Gates set the lane to "Check first"; Riya still decides |
| A missing number lowers the score; it is never skipped | Scores 2 with low confidence, and the gap is named |
| Keys only in environment variables | `.env.local`, git-ignored; the browser never talks to the database |

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind 4. Postgres on Supabase with
row-level security, `pgvector` for retrieval and `pgmq` for the queue. Google Gemini
through a gateway module. Node's built-in test runner via `tsx`.

## Getting started

Requires Node 22 and pnpm.

```bash
pnpm install
cp .env.example .env.local   # then fill in GEMINI_API_KEY at minimum
pnpm seed                    # ingests data/raw into the local store
pnpm dev                     # http://localhost:3000
```

Everything runs with **no API key and no account**: `DATA_BACKEND=local` writes JSON
under `.data/`, and `MODEL_PROVIDER=offline` is a deterministic test double so the
pipeline, the tests and the volume test all run at zero cost. Set `GEMINI_API_KEY` to
use the real model, and `DATA_BACKEND=supabase` to use Postgres.

```bash
pnpm typecheck
pnpm test        # 89 tests
pnpm cost        # cost per call, application, day and month — terminal, not a screen
```

## How it is laid out

```
supabase/migrations/   the schema: 35 tables, RLS on all, pgvector, pgmq
src/lib/
  gateway/             the ONLY module permitted to call a model
    guards.ts          send-less, data-not-instructions, passage budget — all throw
    retry.ts           4 attempts across both models, 1s/2s/4s + jitter
    cost.ts            per-call cost, and the IST daily cap
    providers/         gemini (real) and offline (deterministic test double)
  units.ts             Indian money: lakh, crore, and lakh crore
  market-math.ts       TAM/SAM/SOM recomputed from each deck's own inputs
  redact.ts            founder names to [F1]; contact details removed entirely
  rubric.ts            the thesis as versioned config, in two views
  gates/               G1 stage and cheque, deterministic
  db/                  one Store interface, local and Supabase adapters
```

## The thesis is reconstructed, and shown twice

The fund publishes no scoring rubric and no list of disqualifying categories. What is
public is scattered across press coverage, founder interviews and the fund's own
site; reconstructing a working thesis from that is part of the problem.

Two views ship, and every score says which one produced it:

- **Written** — the public wording: pre-seed and seed in India, fintech, deeptech,
  consumer tech and consumer brands.
- **Revealed** — what twelve deal memos and five partner meetings actually show the
  fund doing. This is the default.

They are kept apart because partner Meeting 5 is an unresolved argument about whether
the fund's behaviour has drifted from its public thesis. Blending them into one
number would quietly pick a side. Each anchor in `rubric.ts` cites the memo or
meeting it came from.

## Decisions

[`DECISIONS.md`](./DECISIONS.md) records each significant choice, what it was chosen
over, and what would make it the wrong call — plus a measurement plan with kill
thresholds, and what the ten applications contain.

## Data

`data/raw/` holds the case material: ten founder forms, ten pitch decks, twelve deal
memos and five partner meeting notes.

**All companies, founders and figures in it are fictional**, authored as teaching
material for the MESA programme. Contact details use the reserved `.example` domain
and are not routable. The real portfolio companies referenced in
`src/lib/seed-data/portfolio.ts` are public information, each row carrying its source.

`.data/` (the local store) and `.env.local` are git-ignored and never committed.

## Status

Phase 1 of 7 complete: schema, seed ingestion, the gateway and its guards, the
deterministic arithmetic, and the tests. The board renders live from seeded data with
gate G1 computed. Scoring, research, the email composer, calibration and the
fine-tuning experiment follow.
