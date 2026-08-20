// ============================================================
// Summary — server-side per-agent snapshot for the mobile page.
// Loops all configured accounts and returns spend / leads / CPL /
// active-campaigns / daily-budget per agent, plus totals.
// Cached briefly so the mobile page can poll cheaply.
// ============================================================
import { config, tokenFor } from "./config.js";
import { meta, actId, leadFrom } from "./meta.js";

// range key -> Meta date_preset
const PRESETS = {
  today: "today",
  yesterday: "yesterday",
  "7d": "last_7d",
  "14d": "last_14d",
  "30d": "last_30d",
};
function presetFor(range) { return PRESETS[range] || PRESETS["7d"]; }

// tiny in-memory cache (per range) so repeated polls don't hammer Meta
const cache = new Map(); // range -> { at:number, data }
const TTL_MS = 120000;   // 2 minutes

async function accountSnapshot(acc, preset) {
  const token = tokenFor(acc);
  const id = actId(acc.account);

  // run the three reads in parallel; tolerate partial failure
  const [insRes, campRes, adsetRes, metaRes] = await Promise.all([
    meta.get(token, `${id}/insights`, {
      level: "account",
      fields: "spend,actions,impressions,clicks",
      date_preset: preset,
    }).catch((e) => ({ __err: e.message })),
    meta.get(token, `${id}/campaigns`, {
      fields: "id,name,effective_status,daily_budget",
      limit: "500",
    }).catch(() => ({ data: [] })),
    meta.get(token, `${id}/adsets`, {
      fields: "campaign_id,daily_budget,effective_status",
      limit: "500",
    }).catch(() => ({ data: [] })),
    meta.get(token, id, { fields: "currency,name" }).catch(() => ({})),
  ]);

  if (insRes && insRes.__err && !(insRes.data)) {
    return { name: acc.name, account: acc.account, error: insRes.__err };
  }

  const row = (insRes.data && insRes.data[0]) || {};
  const spend = parseFloat(row.spend || 0);
  const leads = leadFrom(row.actions);
  const cpl = leads > 0 ? spend / leads : 0;

  const camps = campRes.data || [];
  const adsets = adsetRes.data || [];
  const activeCampaigns = camps.filter((c) => c.effective_status === "ACTIVE").length;

  // daily budget: campaign budget (CBO) if set, else sum of its adsets' budgets
  const adBud = {};
  adsets.forEach((s) => {
    const cid = s.campaign_id;
    adBud[cid] = (adBud[cid] || 0) + parseFloat(s.daily_budget || 0);
  });
  let budMinor = 0;
  camps.forEach((c) => {
    // only count budgets on live campaigns
    if (c.effective_status !== "ACTIVE") return;
    const cdb = parseFloat(c.daily_budget || 0);
    budMinor += cdb > 0 ? cdb : (adBud[c.id] || 0);
  });
  const dailyBudget = budMinor / 100;

  return {
    name: acc.name,
    account: acc.account,
    currency: metaRes.currency || "ILS",
    spend,
    leads,
    cpl,
    activeCampaigns,
    dailyBudget,
  };
}

export async function computeSummary(range = "7d", { force = false } = {}) {
  const key = PRESETS[range] ? range : "7d";
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit && (now - hit.at) < TTL_MS) return hit.data;

  const preset = presetFor(key);
  const per = [];
  for (const acc of config.accounts) {
    try { per.push(await accountSnapshot(acc, preset)); }
    catch (e) { per.push({ name: acc.name, account: acc.account, error: e.message }); }
  }

  const live = per.filter((a) => !a.error);
  const currency = (live[0] && live[0].currency) || "ILS";
  const totalSpend = live.reduce((s, a) => s + (a.spend || 0), 0);
  const totalLeads = live.reduce((s, a) => s + (a.leads || 0), 0);
  const totalBudget = live.reduce((s, a) => s + (a.dailyBudget || 0), 0);
  const totalCampaigns = live.reduce((s, a) => s + (a.activeCampaigns || 0), 0);
  const totals = {
    spend: totalSpend,
    leads: totalLeads,
    cpl: totalLeads > 0 ? totalSpend / totalLeads : 0,
    dailyBudget: totalBudget,
    activeCampaigns: totalCampaigns,
    agents: per.length,
    live: live.length,
    currency,
  };

  const data = {
    range: key,
    generatedAt: new Date().toISOString(),
    currency,
    agents: per,
    totals,
  };
  cache.set(key, { at: now, data });
  return data;
}
