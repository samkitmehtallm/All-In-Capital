/**
 * The fund's thesis and rubric, as versioned config.
 *
 * All In Capital publishes no scoring rubric, no ownership target and no list of
 * disqualifying categories — "no fund does" (Case 3). So this file is a
 * reconstruction, and it is deliberately split in two:
 *
 *   - WRITTEN_VIEW   what the fund says in public: pre-seed and seed in India,
 *                    fintech / deeptech / consumer tech / consumer brands.
 *   - REVEALED_RULES what the twelve memos and five partner meetings actually show
 *                    the fund doing. This is the default scoring view.
 *
 * Every anchor below cites the memo or meeting it came from. That is the difference
 * between a rubric a partner can argue with and a number he will stop trusting
 * without being able to say when (Kushal, Case 3).
 *
 * Riya's open question in Meeting 5 — "should I score against the written thesis or
 * what we actually do?" — got the answer "tell me which one you used and why". Hence
 * both views ship, and every screen shows which one produced the number.
 */

export interface Anchor {
  score: 0 | 3 | 5 | 7 | 10;
  text: string;
  /** Where this anchor comes from: a memo or a partner meeting. */
  source: string;
}

export interface Criterion {
  key: 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6';
  name: string;
  weight: number;
  covers: string;
  /** The one question this criterion is really asking. Shown as "Ask:" on screen. */
  question: string;
  anchors: Anchor[];
}

export type SectorLens = 'consumer_brand' | 'lending_fintech' | 'deeptech' | 'none';

export const CRITERIA: Criterion[] = [
  {
    key: 'c1',
    name: 'Founder-market fit',
    weight: 0.25,
    covers: 'Earned secrets, time in the field. Pedigree alone scores 0.',
    question: 'What does this founder know that a smart outsider would not?',
    anchors: [
      {
        score: 0,
        text: 'Credentials only. An impressive CV with no evidence of time spent on this problem.',
        source: 'Meeting 3 — Kushal on AeroDrop: "credentials are not a business. Score the evidence, not the pedigree."',
      },
      {
        score: 3,
        text: 'Adjacent experience, but the founder has not sat with this customer.',
        source: 'Memo 6 — CampusCredit: strong on campus distribution, no experience in credit, collections or risk.',
      },
      {
        score: 5,
        text: 'Real domain experience, described in general terms rather than specifics.',
        source: 'Memo 2 — Petalry: a strong marketer and a real brand, answering unit-economics questions with channel averages.',
      },
      {
        score: 7,
        text: 'Earned knowledge the deck did not need to explain: specific customers, specific failures.',
        source: 'Memo 3 — Unbox Robotics: "how little they relied on the deck… they described failures before we asked."',
      },
      {
        score: 10,
        text: 'Years on the same hard problem, and the founder can say what would make them quit.',
        source: 'Memo 1 — ePlane: answered "what would make you quit?" with a specific technical milestone.',
      },
    ],
  },
  {
    key: 'c2',
    name: 'Risk ownership',
    weight: 0.2,
    covers: 'Credit, regulation, capital path, liability.',
    question: 'Who carries the thing that can go wrong here?',
    anchors: [
      {
        score: 0,
        text: 'The hardest risk is explicitly somebody else\'s problem.',
        source: 'Memo 6 — CampusCredit: default rates dismissed as "something the NBFC partner handles".',
      },
      {
        score: 3,
        text: 'The risk is acknowledged but treated as secondary to the technology or the growth.',
        source: 'Memo 8 — AeroDrop: customer, regulator and liability all "solved once the tech works".',
      },
      {
        score: 5,
        text: 'The founder names the risk and has a plan that depends on someone they have not hired.',
        source: 'Memo 11 — Jai Kisan: credit-risk depth "would need to be built or hired quickly".',
      },
      {
        score: 7,
        text: 'The founder owns the risk operationally, with groundwork already done.',
        source: 'Memo 11 — Jai Kisan: thousands of farmers registered and assessed before lending scaled.',
      },
      {
        score: 10,
        text: 'The founder takes first loss, or has structured the business so the risk cannot be passed on.',
        source: 'Meeting 2 — Kushal: "label matters less than whether the founders own the risk."',
      },
    ],
  },
  {
    key: 'c3',
    name: 'Customer pull',
    weight: 0.2,
    covers: 'Repeat, conversion, groundwork. Not raw size.',
    question: 'Is anyone coming back without being paid to?',
    anchors: [
      {
        score: 0,
        text: 'Downloads, followers or registrations offered in place of retention.',
        source: 'Memo 12 — Prepnest: strong downloads, no 30- or 90-day numbers.',
      },
      {
        score: 3,
        text: 'Growth bought through paid channels, with repeat not tracked.',
        source: 'Memo 2 — Petalry: two thirds of orders from paid social, repeat rate not tracked.',
      },
      {
        score: 5,
        text: 'Real customers and a plausible story, but conversion or repeat shown only in aggregate.',
        source: 'Meeting 1 — Aditya: "if repeat is good, CAC is survivable. If we can\'t see it, we\'re guessing."',
      },
      {
        score: 7,
        text: 'Repeat or pilot-to-paid conversion shown, with the field work behind it visible.',
        source: 'Memo 9 — SuperK: dozens of store visits, and the founders could say what owners actually wanted.',
      },
      {
        score: 10,
        text: 'Cohort repeat broken out and improving, with the founder fluent in it unprompted.',
        source: 'Memo 7 — Giva: cohort repeat behaviour and gross margin quoted without looking at notes.',
      },
    ],
  },
  {
    key: 'c4',
    name: 'Numbers fluency',
    weight: 0.15,
    covers: 'Cohorts, CAC by channel, figures that reconcile.',
    question: 'Do the numbers on the page agree with each other?',
    anchors: [
      {
        score: 0,
        text: 'Key figures contradict each other, or the market size does not follow from its own inputs.',
        source: 'Memo 1 — ePlane: "market sizing in the deck was aspirational rather than evidenced."',
      },
      {
        score: 3,
        text: 'Figures stated at channel level, with no cohort or per-unit view behind them.',
        source: 'Memo 2 — Petalry: unit economics answered with channel-level averages.',
      },
      {
        score: 5,
        text: 'Figures reconcile, but a central one is missing and its absence is not acknowledged.',
        source: 'Meeting 1 — Kushal: "a missing number should drag the score, not be skipped."',
      },
      {
        score: 7,
        text: 'CAC by channel and margin stated and internally consistent.',
        source: 'Memo 7 — Giva: cost of acquisition by channel, return rate, share of revenue from repeat.',
      },
      {
        score: 10,
        text: 'Cohorts, margin and payback all stated, reconciling across deck and form, including the unflattering ones.',
        source: 'Memo 3 — Unbox Robotics: founders volunteered what broke during pilots.',
      },
    ],
  },
  {
    key: 'c5',
    name: 'Pre-seed fit',
    weight: 0.1,
    covers: 'Capital intensity, valuation, path to the next round.',
    question: 'Does our cheque change this company\'s trajectory, or just its runway?',
    anchors: [
      {
        score: 0,
        text: 'The round or the valuation is beyond what this fund writes.',
        source: 'Written thesis: often the first institutional cheque, $100K–$500K.',
      },
      {
        score: 3,
        text: 'The model only works with far more capital than a pre-seed cheque, and the founders treat that as someone else\'s problem.',
        source: 'Memo 4 — HopBox: "neither could describe a path to profitability that did not depend on a large raise."',
      },
      {
        score: 5,
        text: 'Capital-intensive but staged, with the next round\'s proof point named.',
        source: 'Meeting 1 — Aditya on HopBox: needs "density we can\'t help with".',
      },
      {
        score: 7,
        text: 'A pre-seed cheque reaches a real milestone, and the valuation leaves room for the next round.',
        source: 'Memo 3 — Unbox Robotics: pilot-conversion risk was "the right risk to be carrying at this stage".',
      },
      {
        score: 10,
        text: 'The cheque is sized so even a slow path does not force a bad financing.',
        source: 'Memo 1 — ePlane: "sized the cheque so a slow regulatory path does not force a bad financing."',
      },
    ],
  },
  {
    key: 'c6',
    name: 'Why now and defensibility',
    weight: 0.1,
    covers: 'What changed, and the answer to a well-funded copier.',
    question: 'What stops a better-funded competitor doing this next quarter?',
    anchors: [
      {
        score: 0,
        text: 'The founder is defensive when asked what happens once a larger player copies the format.',
        source: 'Memo 12 — Prepnest: "she bristled at a question about what happens once a larger player copies the format."',
      },
      {
        score: 3,
        text: 'Differentiation rests on being first or on effort, with no structural reason it holds.',
        source: 'Memo 10 — Coinlane: real growth, intense competition from large funded exchanges.',
      },
      {
        score: 5,
        text: 'A clear "why now", but defensibility is asserted rather than shown.',
        source: 'Meeting 3 — the agreement to separate "founder quality" from "path to market".',
      },
      {
        score: 7,
        text: 'Something genuinely changed, and the moat is field execution a copier would have to repeat.',
        source: 'Memo 9 — SuperK: "a franchise-style model with real field execution is hard to copy."',
      },
      {
        score: 10,
        text: 'A milestone sequence through the hard part, which competitors would have to walk too.',
        source: 'Memo 8 vs Memo 1 — AeroDrop passed, ePlane backed, on the presence of a milestone sequence.',
      },
    ],
  },
];

/**
 * Sector lenses multiply the listed weights by 1.5, then everything is renormalised.
 *
 * Each lens is one line from a partner meeting, not a modelling preference.
 */
export const LENSES: Record<Exclude<SectorLens, 'none'>, Partial<Record<Criterion['key'], number>>> = {
  // "That's the whole question for a consumer brand." — Aditya, Meeting 1
  consumer_brand: { c3: 1.5, c4: 1.5 },
  // "Whether the founders own the risk." — Kushal, Meeting 2
  lending_fintech: { c2: 1.5 },
  // "Is there a milestone path?" — Meeting 3, AeroDrop vs ePlane
  deeptech: { c2: 1.5, c6: 1.5 },
};

/** The public wording, scored with no lens, so drift is visible side by side. */
export const WRITTEN_VIEW: Record<Criterion['key'], number> = {
  c1: 0.35,
  c2: 0.15,
  c3: 0.1,
  c4: 0.1,
  c5: 0.1,
  c6: 0.2,
};

export const THRESHOLDS = {
  /** Take the call at 7.5+, no gate tripped, confidence med or better on C1–C3. */
  takeCall: 7.5,
  /** Dig first from 6.0 to 7.49. */
  digFirst: 6.0,
};

/** The nine rules the memos and meetings actually reveal. */
export const REVEALED_RULES = [
  { id: 'R1', text: 'The founder owns the hardest risk.', source: 'Memo 6 vs Memo 11; Meeting 2' },
  { id: 'R2', text: 'Customer groundwork before product.', source: 'Memo 5 (Wint Wealth); Memo 9 (SuperK)' },
  { id: 'R3', text: 'Consumer brands are judged on cohort repeat and margin fluency.', source: 'Memo 7 vs Memo 2; Meeting 1' },
  { id: 'R4', text: 'A missing number lowers the score; it is never skipped.', source: 'Meeting 1 — Kushal on Petalry' },
  { id: 'R5', text: 'The business must fit a pre-seed cheque\'s structure.', source: 'Memo 4 (HopBox) — pass on structure, not people' },
  { id: 'R6', text: 'No company whose existence depends on a favourable regulatory change.', source: 'Memo 10 (Coinlane)' },
  { id: 'R7', text: 'Score evidence, not pedigree.', source: 'Meeting 3 — Kushal on AeroDrop' },
  { id: 'R8', text: 'Defensiveness on weak spots is information.', source: 'Meeting 1; Memo 12 (Prepnest)' },
  { id: 'R9', text: 'Founder behaviour beats the sector label.', source: 'Meeting 2 — rural credit; Memo 11' },
] as const;

export const FUND_RULES = {
  stage: ['pre-seed', 'seed'],
  /** G1: deterministic cheque and valuation bounds. */
  maxRaiseInr: 10_00_00_000, // ₹10 Cr
  maxPostMoneyInr: 40_00_00_000, // ₹40 Cr
  sectorsInThesis: ['fintech', 'deeptech', 'consumer tech', 'consumer brand'],
  sectorsStretch: ['b2b saas', 'commerce infrastructure', 'rural credit'],
  sectorsOutside: ['healthcare', 'web3', 'crypto', 'real estate'],
  /** Meeting 5: Tuesday or Thursday afternoons IST, 30 minutes. */
  callDays: [2, 4] as number[],
  callDurationMinutes: 30,
  /** Meeting 3: Aditya joins deeptech calls. */
  adityaJoinsSectors: ['deeptech'],
  /** Meeting 4: "I would rather get a flag on a false alarm than miss a real conflict." */
  conflictFlagAlways: true,
} as const;

export interface ScoringView {
  name: 'revealed' | 'written';
  weights: Record<Criterion['key'], number>;
  lensApplied: SectorLens;
}

/**
 * Resolve the weights for one application.
 *
 * Multiply the lens criteria by 1.5, then renormalise so the weights still sum to 1.
 * Renormalising rather than letting them sum to 1.2 matters: without it, a lensed
 * application is scored out of a different total and is no longer comparable with
 * the rest of the board, which is the one thing ranking needs.
 */
export function resolveWeights(view: 'revealed' | 'written', lens: SectorLens): ScoringView {
  if (view === 'written') {
    return { name: 'written', weights: { ...WRITTEN_VIEW }, lensApplied: 'none' };
  }

  const base = Object.fromEntries(CRITERIA.map((c) => [c.key, c.weight])) as Record<
    Criterion['key'],
    number
  >;

  if (lens !== 'none') {
    for (const [key, multiplier] of Object.entries(LENSES[lens])) {
      base[key as Criterion['key']] *= multiplier as number;
    }
  }

  const total = Object.values(base).reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, v / total]),
  ) as Record<Criterion['key'], number>;

  return { name: 'revealed', weights, lensApplied: lens };
}

/** Which lens a sector gets. Derived from the sector the pipeline resolves, not the one declared. */
export function lensForSector(sector: string | null | undefined): SectorLens {
  if (!sector) return 'none';
  const s = sector.toLowerCase();
  if (s.includes('consumer brand')) return 'consumer_brand';
  if (s.includes('deeptech') || s.includes('hardware')) return 'deeptech';
  if (s.includes('lending') || s.includes('credit')) return 'lending_fintech';
  return 'none';
}

/** The config snapshot written to rubric_versions on seed. */
export function rubricConfigV1() {
  return {
    version: 1,
    label: 'Reconstructed from twelve memos and five partner meetings',
    criteria: CRITERIA,
    lenses: LENSES,
    written_view: WRITTEN_VIEW,
    thresholds: THRESHOLDS,
    fund_rules: { ...FUND_RULES, revealed_rules: REVEALED_RULES },
    is_active: true,
  };
}
