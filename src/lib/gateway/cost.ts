/**
 * Per-call cost accounting.
 *
 * The founder does not want cost in the UI (brief §13), so these numbers exist for
 * the terminal report and the daily cap, not for a screen. Rates are a config value
 * with a date on them, because a hardcoded price silently goes stale and then every
 * payback calculation downstream is wrong.
 */

export interface ModelRate {
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
}

/**
 * Published list prices. Update `RATES_VERIFIED_ON` whenever these change, and say
 * so in the cost report, so a stale rate is visible rather than assumed.
 */
export const RATES_VERIFIED_ON = '2026-11-24';

export const RATES: Record<string, ModelRate> = {
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  'gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-embedding-001': { inputPerM: 0.15, outputPerM: 0 },
  'text-embedding-004': { inputPerM: 0, outputPerM: 0 },
  /** The offline provider costs nothing and is recorded as such. */
  offline: { inputPerM: 0, outputPerM: 0 },
};

export function rateFor(model: string): ModelRate {
  if (RATES[model]) return RATES[model];
  // An unknown model is charged at the most expensive known rate rather than zero:
  // a cost report that under-reports is worse than one that over-reports.
  const worst = Object.values(RATES).reduce((a, b) =>
    a.inputPerM + a.outputPerM > b.inputPerM + b.outputPerM ? a : b,
  );
  return worst;
}

export const USD_TO_INR = Number(process.env.USD_TO_INR ?? 88);

export interface CostBreakdown {
  usd: number;
  inr: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the rate table had no entry and the worst known rate was used. */
  rateAssumed: boolean;
}

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const rate = rateFor(model);
  const usd = (inputTokens / 1e6) * rate.inputPerM + (outputTokens / 1e6) * rate.outputPerM;
  return {
    usd,
    inr: usd * USD_TO_INR,
    model,
    inputTokens,
    outputTokens,
    rateAssumed: !RATES[model],
  };
}

/**
 * Today's date in IST, as a YYYY-MM-DD string.
 *
 * The daily cap resets at midnight IST (§12.5), which is not midnight anywhere the
 * code is likely to run, so the boundary is computed explicitly rather than taken
 * from the host clock's local day.
 */
export function istDay(at: Date = new Date()): string {
  const istMs = at.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

/** Milliseconds until the next midnight IST — what the banner's "after midnight" means. */
export function msUntilNextIstMidnight(at: Date = new Date()): number {
  const istMs = at.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const nextMidnightIst = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return nextMidnightIst - istMs;
}
