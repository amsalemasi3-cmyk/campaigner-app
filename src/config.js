// ============================================================
// Configuration — everything is driven by environment variables
// so you never hardcode secrets. Set these in Railway → Variables.
// ============================================================

function bool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === "true" || v === "1";
}
function num(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

// ACCOUNTS: JSON array like
// [{"name":"אשר","account":"act_895183153110520","token":"OPTIONAL_PER_AGENT_TOKEN"}]
function parseAccounts() {
  try {
    const arr = JSON.parse(process.env.ACCOUNTS || "[]");
    return Array.isArray(arr) ? arr.filter((a) => a && a.account) : [];
  } catch (e) {
    console.error("⚠️  ACCOUNTS env is not valid JSON — using empty list.");
    return [];
  }
}

export const config = {
  // --- auth / meta ---
  metaToken: process.env.META_TOKEN || "",          // System User token WITH ads_management
  apiVer: process.env.META_API_VERSION || "v23.0",
  accounts: parseAccounts(),

  // --- api security (dashboard talks to this server) ---
  apiKey: process.env.API_KEY || "change-me",       // simple shared-secret header
  port: num(process.env.PORT, 3000),

  // --- scheduler ---
  cron: process.env.CRON || "*/30 * * * *",         // every 30 min by default
  windowDays: num(process.env.WINDOW_DAYS, 7),      // look-back window for analysis

  // --- SAFETY: master switches ---
  dryRun: bool(process.env.DRY_RUN, true),          // TRUE = recommend only, execute NOTHING
  killSwitch: bool(process.env.KILL_SWITCH, false), // TRUE = freeze everything

  // --- autonomy per action type (only matter when dryRun=false) ---
  autoPause: bool(process.env.AUTO_PAUSE, false),   // auto-pause burners / weak creatives
  autoBudget: bool(process.env.AUTO_BUDGET, false), // auto up/down budget

  // --- guardrails (currency MAJOR units, e.g. shekels) ---
  budgetCapDaily: num(process.env.BUDGET_CAP_DAILY, 500),   // never raise an adset above this/day
  maxBudgetChangePct: num(process.env.MAX_BUDGET_CHANGE_PCT, 25), // cap single change
  minLeadsBeforeAction: num(process.env.MIN_LEADS_BEFORE_ACTION, 0),
  minImpressionsForCreative: num(process.env.MIN_IMPRESSIONS_CREATIVE, 800),

  // --- optimization thresholds (tune to your niche) ---
  ctrLow: num(process.env.CTR_LOW, 0.008),          // below this = weak creative
  freqHigh: num(process.env.FREQ_HIGH, 3.0),        // above this = fatigue
  cplExpensiveMult: num(process.env.CPL_EXPENSIVE_MULT, 2.0), // x median = expensive
  cplWinnerMult: num(process.env.CPL_WINNER_MULT, 0.7),       // x median = winner
  budgetDownFactor: num(process.env.BUDGET_DOWN_FACTOR, 0.7), // reduce to 70%
  budgetUpFactor: num(process.env.BUDGET_UP_FACTOR, 1.2),     // raise to 120%
  leadTypeMode: process.env.LEAD_MODE || "auto",    // auto | pixel | custom
  leadCustom: process.env.LEAD_CUSTOM || "",
};

export function tokenFor(account) {
  return (account.token && account.token.trim()) || config.metaToken;
}
