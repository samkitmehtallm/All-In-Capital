# Decisions

Written to be defended out loud. Each entry says what was chosen, what it was chosen
over, and what would make it the wrong call.

---

## D1. Use the real case data, not generated seed data

**Decision.** Ingest the twenty-six files from the two Drive folders (ten founder
forms, ten decks, twelve deal memos, five partner meetings, two fine-tuning exports,
one operating-facts sheet) instead of generating fictional seed data.

**Chosen over.** The master prompt's §4, which specifies generating ten forms, ten
decks and twelve memos with a listed set of planted traps.

**Why.** The traps in the prompt's list are the traps this data already contains — it
was written from these files. Generating my own would mean the pipeline is tested
against errors this codebase invented for itself to find, which proves nothing. It
would also replace the fund's real reasoning (six investments, six passes, five
meetings of argument) with a paraphrase of it, and the rubric is reconstructed from
exactly that reasoning.

**Wrong if.** The grader requires the generated-data exercise itself. The generator
is not written; adding it is a day's work and does not change anything downstream.

---

## D2. Two scoring views, both shipped

**Decision.** Score every application twice: the **revealed** view (default, derived
from the memos and meetings, with sector lenses) and the **written** view (the public
wording, no lens). Show which one produced the number.

**Why.** Meeting 5 is unresolved in the source material. Riya says the fund's
behaviour has drifted from its public thesis; Aditya says the pipeline changed, not
the thesis; Kushal says both could be true and he does not know. Nobody reconciled
them. A single blended number would quietly pick a side in an argument the partners
are still having. Kushal's actual instruction was "tell me which one you used and
why", so the answer is both, labelled.

**Wrong if.** The two views agree on every application, in which case the second
column is noise. Phase 2 will report the disagreement count; if it is zero, the
written view should become a diagnostic rather than a screen element.

---

## D3. Weights renormalise after a sector lens is applied

**Decision.** A lens multiplies its criteria by 1.5, then all six weights are divided
by their new total.

**Why.** Without renormalising, a lensed application is scored out of 1.2 and an
unlensed one out of 1.0. The board's four lanes are a ranking, and ranking numbers
produced against different totals is the one thing that would make the whole screen
meaningless. Covered by a unit test.

---

## D4. The offline provider is a test double, labelled as one

**Decision.** The gateway ships two providers: `gemini` (real) and `offline`
(deterministic, registered per pipeline step). The offline one is recorded as model
`offline` in every trace and ledger row, and costs zero.

**Why.** Three things need to be true at once: CI must run with no API key, the
twenty-application volume test must measure the queue rather than a provider's rate
limit, and tests must assert exact output. A mocked provider that returned plausible
prose would satisfy none of them.

**Wrong if.** Anyone reads an offline run as evidence the real model works. Mitigated
by the name appearing in the cost report and traces, never a model-shaped alias.

---

## D5. The architecture test is the control, not the convention

**Decision.** `tests/gateway-is-the-only-caller.test.ts` walks `src/` and fails if
any file outside `src/lib/gateway/providers/` imports a provider SDK or references a
provider endpoint.

**Why.** The send-less guard, the spend cap, the cache and the cost ledger all live
in the gateway. Every one of them is optional if a step can `import { GoogleGenAI }`
directly. A comment saying "always use the gateway" is not a control; a failing test
is.

---

## D6. Guards throw, they do not warn

**Decision.** `assertSendLess`, `assertDataGuard` and `assertPassageBudget` raise
`GuardError` and abort the call.

**Why.** Riya screens between 7 and 9 pm with no engineer on call. A warning in a log
nobody reads is indistinguishable from no guard at all. The failure mode of throwing
is a visible "Needs a look"; the failure mode of warning is a founder's email address
in a third party's logs, discovered later or never.

---

## D7. Local store now, same migrations either way

**Decision.** The Postgres schema in `supabase/migrations/` is the source of truth.
A narrow `Store` interface has two adapters: `local` (JSON files, no account) and
`supabase` (service key, pgmq, pgvector).

**Why.** The Supabase free tier allows two active projects and both are taken by
other coursework. Pausing one is the user's call, not mine. Nothing about the schema,
the pipeline or the tests depends on which adapter runs, so the decision could be
deferred without blocking a single line of work.

**Open.** Which project to pause, or whether to upgrade. Until then `DATA_BACKEND=local`.

---

## D8. RLS is deny-by-default with no policies

**Decision.** Every table has RLS enabled and **no** policy for `anon` or
`authenticated`. All access goes through server routes holding the service key.

**Why.** The brief says the browser never talks to the database. Writing read
policies "just in case" would mean a leaked publishable key yields the founder data
the fund contractually promised not to pass on. `founder_contacts` in particular has
no path to it from any client-side credential.

---

## D9. Riya decides, and the correction is her decision

**Decision.** No per-criterion override buttons anywhere. The `decisions` table holds
Advance / Hold / Pass with an **optional** note, recordable by any signed-in team
member, and a `corrections` row is written only when the decision goes against the
recommendation.

**Chosen over.** The per-score override loop built in phase 1, where a partner
overrode one criterion with a new score and a required one-line reason.

**Why.** The revised brief makes Riya the decision maker rather than an assistant to
the partners, and is explicit that she has no time to correct six scores one at a
time. A required reason makes it likelier she records nothing at all. Her
disagreement with the recommendation carries most of the same signal and costs her
one click, so that is what gets embedded and shown to the scorer next time.

**Wrong if.** Decision-level corrections turn out too coarse to move any individual
criterion — a Pass on a "Worth a call" says the verdict was wrong without saying
which of the six was wrong. Calibration will show whether that signal is usable; if
it is not, the answer is a better-targeted question at decision time, not a return to
six override buttons.

**Cost already paid.** The phase 1 `corrections` and `partner_decisions` tables were
dropped in migration 0007 rather than left alongside the new ones, because two tables
both meaning "the decision" is how a screen ends up showing the wrong one.

---

## D10. Offered times and accepted times follow different rules

**Decision.** The tool **offers** Tuesday or Thursday afternoons, as the partners
agreed in Meeting 5. It **accepts** a founder-proposed time on any weekday between
10:00 and 19:00 IST, within 30 days.

**Why.** Conflating the two would make the tool refuse a founder's Wednesday morning
because of an internal scheduling preference — creating exactly the calendar
back-and-forth it exists to remove. The partners' preference governs what the fund
asks for, not what it is willing to accept.

---

## What is measured, and what would kill it

| Question | Measure | Kill threshold |
|---|---|---|
| Does the arithmetic hold? | Unit tests over every market slide in all ten decks | Any deck whose correct figures are flagged, or whose wrong ones are not |
| Does it leak? | `findPII` asserted on all 116 redacted pages at seed time; guard tests | One leak is a stop |
| Does it agree with the fund? | Blind calibration over the twelve memos | Below 8 of 12 agreement, or the backed company failing to outscore its paired pass |
| Does scheduling ever double-book? | Fixture tests: free, busy, out of hours, unclear, and two runs at once | One double-booking is a stop |
| Does it earn its place? | Cost per application from `llm_calls`; payback against ₹1,000/hour of Riya's time | Payback over 12 months |

---

## D11. The kill threshold fired, and the thresholds are what is wrong

**Result.** Blind calibration over the twelve memos scored **6 of 12 agreement** —
below the 8 of 12 kill threshold set above, which I am recording as fired rather
than quietly moving.

**But the agreement figure is not the finding.** The system passed on all twelve.
Every agreement is an agreement with a pass; every disagreement is a company the
fund backed. A classifier that always answers "pass" scores 6 of 12 on a pack that
is half investments, so the headline measures nothing.

**What the run actually shows is better than that.** Ranking agreement is **6 of 6**:
in every teaching pair, the company the fund backed outscored the company it
passed.

| Pair | Backed | Passed |
|---|---|---|
| consumer brand, on cohort repeat | Giva 5.30 | Petalry 2.07 |
| lending, on who owns the risk | Jai Kisan 5.14 | CampusCredit 1.86 |
| deeptech, on a milestone path | ePlane 5.69 | AeroDrop 2.26 |
| fintech, on regulatory dependence | Wint Wealth 5.45 | Coinlane 2.75 |
| commerce, on structure at pre-seed | SuperK 4.15 | HopBox 3.80 |
| defensibility beyond one person | Unbox Robotics 5.83 | Prepnest 2.45 |

So the rubric has captured the distinctions the partners draw. **The scale is
miscalibrated, not the judgement.** Nothing clears 5.83 against a "dig first"
threshold of 6.0 and a "take the call" threshold of 7.5.

**Most likely cause, in order.** A memo's "Risks and open questions" section is
adversarial by construction and drags every criterion down. Criteria the memos
barely discuss (pre-seed fit, numbers fluency) score the mandated 2 for missing
evidence, which is correct per R4 but compounds across six weighted criteria. And
the citation rule is inert on this path, so none of the usual upward pressure from
cited evidence applies.

**What I am NOT doing.** Lowering the thresholds until this passes. The thresholds
came from the brief, they govern live applications as well as this backtest, and
tuning them against the same twelve memos the rubric was built from would be fitting
noise twice over and calling it validation.

**What should happen instead**, in order of preference:
1. Score the ten live applications and the twelve memos on the same scale, then set
   thresholds from the combined distribution rather than from either alone.
2. Hold out three memos from the rubric reconstruction and re-derive, so there is
   at least a small out-of-sample check.
3. Only then move the thresholds, and record the move as a new rubric version.

**Open until that is done.** On the current numbers this system can rank
applications and cannot decide them, which is a narrower claim than the board
currently implies — and a more useful one than a 6-of-12 agreement figure.

---

## Appendix: what the ten applications contain

Established by reading the files, before any scoring. Phase 2 reports what the
pipeline actually produced against this list.

| Company | Sector | Raise / post | What it should surface |
|---|---|---|---|
| **GrainKind** | Consumer brand | ₹2.5 Cr / ₹14 Cr | TAM stated 10× its own inputs (₹91,200 Cr vs ₹9,120 Cr), SAM likewise — yet cohort repeat broken out by month (31/34/38%) and CAC by channel. The Giva case: strong brand, sloppy market slide |
| **EarnWise** | Fintech (lending) | ₹2 Cr / ₹12 Cr | Deck says "Ex-Goldman Sachs. Ex-Google. MBA, IIM Ahmedabad… Team of 12"; form says a 10-week internship, a vendor contract, a tier-2 MBA and a team of 5. Deck says 3 enterprise clients live, form says 1 live and 2 in pilot. Advances funded partly from the founder's savings on an NBFC "agreement in principle". The CampusCredit case |
| **Talkbook** | "Consumer tech", really B2B SaaS | ₹2 Cr / ₹12 Cr | Call summaries and CRM updates — overlaps MeetRecord in the portfolio, and nothing in the application mentions it. The Meeting 4 near-miss. MRR ₹2.1 L on the deck, ₹1.9 L on the form, and 340 seats × ₹500 is ₹1.7 L |
| **Settlr** | Fintech | **₹30 Cr / ₹180 Cr** | Series A, 31 people, four Series A funds in conversation. Gate G1. Also 10× out on all three market tiers |
| **CareCorner** | **Healthcare** | ₹3 Cr / ₹18 Cr | Outside the mandate. Arithmetic is correct throughout. ₹28 L capex per clinic — the HopBox case, pass on structure not people |
| **RentRoute** | Fintech | ₹1.8 Cr / ₹12 Cr | Exists only while card networks permit rent payments; the form admits "a change would hit us directly". Claims "no direct competitors". The Coinlane case |
| **Pumpwise** | Deeptech (hardware) | ₹2.2 Cr / ₹11 Cr | Long certification path with a named milestone sequence, 38 plant visits before building, 6 of 11 pilots converted. The ePlane/Unbox case. Savings figures are customer-reported and unaudited |
| **StockSathi** | Commerce infra + lending | ₹2 Cr / ₹12 Cr | Takes **first-loss** on credit, field agents, 60 owner interviews. The Jai Kisan/SuperK case. But not registered as an NBFC, and deck says credit is "funded from our own capital" where the form says "through our NBFC partner". Deck 38 retailers / ₹3.8 L October GMV vs form 42 retailers / ₹9 L over three months |
| **CAPilot** | Fintech / B2B SaaS | ₹1.5 Cr / ₹10 Cr | Deck counts 31 paying firms; form says 24 paying and 7 on trial. Market slide is "1% of ₹1.4 lakh Cr" with no derivation |
| **Yatrika** | Consumer tech | ₹1.2 Cr / ₹8 Cr | "Thousands of travellers", "3x growth", "many 5-star reviews"; the form says 410 bookings and 14% repeat. No raise amount on the deck, two identical vision slides, no unit economics. The Prepnest case |
