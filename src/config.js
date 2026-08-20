// ============================================================
// Configuration — everything is driven by environment variables
// so you never hardcode secrets. Set these in Railway → Variables.
// ============================================================

import { store } from "./store.js";

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

  // --- dashboard login (optional; if set, login is validated by the SERVER
  //     so the same user/pass works on every device and nothing "resets") ---
  adminUser: process.env.ADMIN_USER || "",
  adminPass: process.env.ADMIN_PASS || "",

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

  // --- CREATION / A-B autonomy (all OFF by default; also gated by dryRun) ---
  autoSwap: bool(process.env.AUTO_SWAP, false),     // auto-replace fatigued/weak creatives from the bank
  autoCreate: bool(process.env.AUTO_CREATE, false), // allow creating campaigns/adsets/ads
  abTestDays: num(process.env.AB_TEST_DAYS, 4),     // how long an A/B runs before deciding
  abMinResults: num(process.env.AB_MIN_RESULTS, 30),// min leads (or clicks) before deciding
  abConfidence: num(process.env.AB_CONFIDENCE, 0.9),// probability threshold to declare a winner

  // --- LLM copywriter (optional; needs your own API key) ---
  llmApiKey: process.env.LLM_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "claude-sonnet-4-5", // set to a model your key can use
  llmProvider: process.env.LLM_PROVIDER || "anthropic",

  // --- rejection / block handler ---
  autoFixRejections: bool(process.env.AUTO_FIX_REJECTIONS, false), // auto-swap rejected ads from the bank
  rejectionMaxRetries: num(process.env.REJECTION_MAX_RETRIES, 1),  // attempts before alerting a human
};
export function llmReady() { return !!config.llmApiKey && !!config.llmModel; }

// Launch defaults — the Meta fields required to CREATE anything.
// Set LAUNCH_DEFAULTS as JSON; per-account overrides can live on each ACCOUNTS entry.
function parseLaunch() {
  let d = {};
  try { d = JSON.parse(process.env.LAUNCH_DEFAULTS || "{}"); } catch (e) { console.error("⚠️  LAUNCH_DEFAULTS is not valid JSON."); }
  return {
    pageId: d.pageId || d.page_id || "",
    instagramId: d.instagramId || d.instagram_id || "",
    pixelId: d.pixelId || d.pixel_id || "",
    objective: d.objective || "OUTCOME_LEADS",
    optimizationGoal: d.optimizationGoal || "OFFSITE_CONVERSIONS",
    billingEvent: d.billingEvent || "IMPRESSIONS",
    customEventType: d.customEventType || "LEAD",
    linkUrl: d.linkUrl || d.link || "",
    ctaType: d.ctaType || d.cta || "LEARN_MORE",
    countries: d.countries || ["IL"],
    ageMin: d.ageMin || 18,
    ageMax: d.ageMax || 65,
    dailyBudgetMinor: d.dailyBudgetMinor || d.dailyBudget || 5000, // minor units (5000 = ₪50)
  };
}
export const launchDefaults = parseLaunch();

export function tokenFor(account) {
  return (account && account.token && account.token.trim()) || config.metaToken;
}
export function accountFromId(id) {
  return config.accounts.find((a) => a.account === id) || { account: id };
}
// Merge global launch defaults + env per-account overrides + runtime (UI) overrides.
export function launchCfg(account) {
  const id = account && account.account;
  const envOverride = (account && account.launch) || {};
  const runtime = (id && store.launchConfigs && store.launchConfigs[id]) || {};
  return { ...launchDefaults, ...envOverride, ...runtime };
}
// Is the account launch-ready? (has the Meta fields Meta requires)
export function launchReady(account) {
  const l = launchCfg(account);
  const missing = [];
  if (!l.pageId) missing.push("pageId");
  if (!l.linkUrl) missing.push("linkUrl");
  if (l.optimizationGoal === "OFFSITE_CONVERSIONS" && !l.pixelId) missing.push("pixelId");
  return { ready: missing.length === 0, missing };
}
