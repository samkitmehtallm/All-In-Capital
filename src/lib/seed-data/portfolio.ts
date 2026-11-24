/**
 * All In Capital's portfolio.
 *
 * The case withholds this deliberately: "its existing portfolio … is not given.
 * Where it exists publicly, you find it. Where it doesn't, you say so, and you say
 * what that absence costs your system."
 *
 * So every row carries a `sourceUrl` and a `sourceNote` saying where it came from,
 * and rows whose description could not be sourced keep `oneLiner: null` rather than
 * getting a plausible-sounding guess. A guessed one-liner would be worse than a
 * blank one here, because gate G3 matches an applicant's product against these
 * descriptions — an invented description produces an invented conflict, and Meeting 4
 * is explicit that the cost of a missed conflict is a call with a founder the fund
 * cannot actually take.
 *
 * Provenance has two kinds:
 *   'public'  — named on the fund's own site or in press coverage, linked below.
 *   'memo'    — named in the fund's twelve-memo pack as a company it backed. The
 *               memos are the fund's own record, so they are authoritative here even
 *               where public coverage attributes the deal to Kushal Bhagia's earlier
 *               fund, First Cheque. Phase 5 surfaces that distinction on screen.
 */

export interface PortfolioSeed {
  name: string;
  oneLiner: string | null;
  sector: string | null;
  status: 'active' | 'exited' | 'shut_down';
  tags: string[];
  domain: string | null;
  sourceUrl: string;
  sourceNote: string;
}

const SITE = 'https://www.allincapital.vc/';
const INC42_FUND2 = 'https://inc42.com/buzz/all-in-capital-launches-inr-200-cr-fund-ii/';
const INC42_FEATURE = 'https://inc42.com/features/inside-all-in-capitals-inr-300-cr-bet-on-indias-next-wave-of-founders/';
const YOURSTORY = 'https://yourstory.com/2025/03/all-in-capital-launches-fund-ii-rs-200cr-target-corpus';
const MEMOS = 'data/raw/Deal_Memos.pdf';
const MEETINGS = 'data/raw/Partner_Meeting_Notes.pdf';

export const PORTFOLIO: PortfolioSeed[] = [
  // -- named on the fund's own site -----------------------------------------
  {
    name: 'PierSight',
    oneLiner: 'Satellite-based maritime surveillance for oil-spill and vessel monitoring.',
    sector: 'deeptech',
    status: 'active',
    tags: ['space', 'satellites', 'maritime'],
    domain: 'piersight.space',
    sourceUrl: SITE,
    sourceNote: 'Named on the fund site; the case study notes first call to term sheet in 11 days.',
  },
  {
    name: 'NewMe',
    oneLiner: 'Fast-fashion brand for young Indian women, online and in stores.',
    sector: 'consumer brand',
    status: 'active',
    tags: ['d2c', 'fashion', 'retail'],
    domain: 'newme.asia',
    sourceUrl: SITE,
    sourceNote: 'Named on the fund site as an early bet.',
  },
  {
    name: 'Magma',
    oneLiner: null,
    sector: null,
    status: 'active',
    tags: [],
    domain: null,
    sourceUrl: SITE,
    sourceNote: 'Named on the fund site as a first-round bet. No description found in public sources.',
  },
  {
    name: 'Broccoli AI',
    oneLiner: null,
    sector: 'consumer tech',
    status: 'active',
    tags: ['ai'],
    domain: null,
    sourceUrl: SITE,
    sourceNote: 'Named on the fund site. Sector inferred from the name only; description not sourced.',
  },

  // -- Fund II investments reported in press --------------------------------
  {
    name: 'Taakat',
    oneLiner: 'Mass-market FMCG brand.',
    sector: 'consumer brand',
    status: 'active',
    tags: ['fmcg', 'd2c'],
    domain: null,
    sourceUrl: INC42_FUND2,
    sourceNote: 'Reported as a Fund II investment.',
  },
  {
    name: 'MedMitra',
    oneLiner: 'AI co-pilot for doctors.',
    sector: 'healthcare',
    status: 'active',
    tags: ['ai', 'clinical'],
    domain: null,
    sourceUrl: INC42_FUND2,
    sourceNote:
      'Reported as a Fund II investment. Worth noting against the thesis: healthcare reads as outside the written mandate, and this row is evidence the mandate has moved.',
  },
  {
    name: 'Spill Games',
    oneLiner: 'Mobile gaming studio.',
    sector: 'consumer tech',
    status: 'active',
    tags: ['gaming', 'mobile'],
    domain: null,
    sourceUrl: INC42_FUND2,
    sourceNote: 'Reported as a Fund II investment.',
  },
  {
    name: 'Krrvy',
    oneLiner: 'Shapewear and lingerie brand for Indian women.',
    sector: 'consumer brand',
    status: 'active',
    tags: ['d2c', 'apparel'],
    domain: null,
    sourceUrl: INC42_FUND2,
    sourceNote: 'Reported as a Fund II investment.',
  },
  {
    name: 'Mixar',
    oneLiner: 'AI for 3D modelling and animation.',
    sector: 'deeptech',
    status: 'active',
    tags: ['ai', '3d'],
    domain: null,
    sourceUrl: INC42_FUND2,
    sourceNote: 'Reported as a Fund II investment.',
  },

  // -- portfolio companies named in coverage --------------------------------
  {
    name: 'MeetRecord',
    // This description is load-bearing. Gate G3 matches every applicant's product
    // against it, and Talkbook — "AI call summaries and CRM updates for Indian sales
    // teams" — is the overlap Meeting 4 says was only caught because Riya happened
    // to know the portfolio.
    oneLiner: 'Records and analyses sales calls, with summaries and CRM updates for revenue teams.',
    sector: 'b2b saas',
    status: 'active',
    tags: ['sales', 'call recording', 'revenue intelligence', 'crm'],
    domain: 'meetrecord.com',
    sourceUrl: INC42_FEATURE,
    sourceNote:
      'Named in coverage, and discussed in partner Meeting 4 as the portfolio company an inbound meeting-notes startup overlapped with.',
  },
  {
    name: 'Hotelzify',
    oneLiner: 'Direct-booking websites for independent hotels.',
    sector: 'b2b saas',
    status: 'active',
    tags: ['travel', 'bookings'],
    domain: 'hotelzify.com',
    sourceUrl: YOURSTORY,
    sourceNote: 'Named in coverage of the Fund II announcement.',
  },
  {
    name: 'Vaaree',
    oneLiner: 'Home and kitchen brand selling online.',
    sector: 'consumer brand',
    status: 'active',
    tags: ['d2c', 'home'],
    domain: 'vaaree.com',
    sourceUrl: INC42_FEATURE,
    sourceNote: 'Named in coverage as an early bet.',
  },
  {
    name: 'SuperNova',
    oneLiner: null,
    sector: null,
    status: 'active',
    tags: [],
    domain: null,
    sourceUrl: YOURSTORY,
    sourceNote: 'Named in coverage. No description found; the name is too generic to infer one.',
  },
  {
    name: 'Volt',
    oneLiner: null,
    sector: null,
    status: 'active',
    tags: [],
    domain: null,
    sourceUrl: YOURSTORY,
    sourceNote: 'Named in coverage. No description found.',
  },
  {
    name: 'Slick',
    oneLiner: null,
    sector: null,
    status: 'active',
    tags: [],
    domain: null,
    sourceUrl: YOURSTORY,
    sourceNote: 'Named in coverage. No description found.',
  },
  {
    name: 'Arva',
    oneLiner: null,
    sector: null,
    status: 'active',
    tags: [],
    domain: null,
    sourceUrl: YOURSTORY,
    sourceNote: 'Named in coverage. No description found.',
  },

  // -- the fund's own memo pack ---------------------------------------------
  {
    name: 'The ePlane Company',
    oneLiner: 'Electric vertical take-off aircraft and UAVs for short intracity trips.',
    sector: 'deeptech',
    status: 'active',
    tags: ['aerospace', 'evtol', 'hardware'],
    domain: 'eplane.in',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 1, INVESTED. Backed on the founders rather than the deck\'s market size.',
  },
  {
    name: 'Unbox Robotics',
    oneLiner: 'Compact robotic package-sorting systems for warehouses and fulfilment centres.',
    sector: 'deeptech',
    status: 'active',
    tags: ['robotics', 'logistics', 'hardware'],
    domain: 'unboxrobotics.com',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 3, INVESTED. Deeptech with a nearer path to revenue than most.',
  },
  {
    name: 'Wint Wealth',
    oneLiner: 'Makes bond-market products accessible to retail investors in India.',
    sector: 'fintech',
    status: 'active',
    tags: ['bonds', 'fixed income', 'retail investing'],
    domain: 'wintwealth.com',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 5, INVESTED. Founder did unscalable things in the right order.',
  },
  {
    name: 'Giva',
    oneLiner: 'Online-first fine silver jewellery brand, now also gold and lab-grown diamonds.',
    sector: 'consumer brand',
    status: 'active',
    tags: ['d2c', 'jewellery', 'cohort repeat'],
    domain: 'giva.co',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 7, INVESTED. The brand that passed the repeat-rate test the others fail.',
  },
  {
    name: 'SuperK',
    oneLiner: 'Tech-enabled grocery retail network rebranding neighbourhood stores in small towns.',
    sector: 'consumer tech',
    status: 'active',
    tags: ['retail', 'small town', 'commerce infrastructure'],
    domain: 'superk.in',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 9, INVESTED. Founder behaviour decided it; cited in Meeting 5 as evidence of drift.',
  },
  {
    name: 'Jai Kisan',
    oneLiner: 'Financing for farmers and rural households buying income-generating equipment.',
    sector: 'fintech',
    status: 'active',
    tags: ['rural credit', 'agri', 'lending'],
    domain: 'jai-kisan.com',
    sourceUrl: MEMOS,
    sourceNote: 'Memo 11, INVESTED. The rural-credit stretch resolved in Meeting 2.',
  },
];

/**
 * What this list does not know.
 *
 * Stated on the Portfolio screen rather than hidden, because an applicant that
 * overlaps an undescribed company cannot be caught by G3, and that is a real limit
 * on what the conflict check can promise.
 */
export const PORTFOLIO_GAPS = {
  missingDescription: PORTFOLIO.filter((p) => !p.oneLiner).map((p) => p.name),
  note:
    'All In Capital does not publish a complete portfolio list. These rows come from ' +
    'the fund site, press coverage and the memo pack. Companies with no description ' +
    'cannot be matched by the conflict check, so G3 under-reports by exactly that much.',
  chequeSize: {
    public: 'USD 250,000 to 600,000 (allincapital.vc, Nov 2026)',
    briefed: 'USD 100,000 to 500,000 (master prompt §5)',
    note:
      'These disagree. The deterministic G1 bound uses rupee figures from the brief ' +
      '(raise up to INR 10 Cr, post-money up to INR 40 Cr) rather than either dollar ' +
      'range, and the disagreement is recorded here rather than silently resolved.',
  },
};
