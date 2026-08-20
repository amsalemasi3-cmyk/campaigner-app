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

// ============================================================
// Full 30-day per-agent series — the shape the main dashboard's
// overview / agents table / charts expect (same as its old
// client-side fetch, but computed here so it works on any device).
// ============================================================
function isoLocal(d) { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function todayLocal() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

let agentsCache = { at: 0, data: null };
export async function computeAgentsData({ force = false } = {}) {
  const now = Date.now();
  if (!force && agentsCache.data && (now - agentsCache.at) < TTL_MS) return agentsCache.data;
  const per = [];
  for (const acc of config.accounts) {
    try { per.push(await agentSeries(acc)); }
    catch (e) { per.push({ name: acc.name, account: acc.account, currency: null, activeCampaigns: 0, campaignNames: [], daily: [], dailyBudget: 0, campaigns: null, ads: null, error: e.message }); }
  }
  const live = per.filter((a) => !a.error);
  const currency = (live.find((a) => a.currency) || {}).currency || "ILS";
  const data = { generatedAt: new Date().toISOString(), currency, agents: per };
  agentsCache = { at: now, data };
  return data;
}

async function agentSeries(acc) {
  const token = tokenFor(acc);
  const id = actId(acc.account);
  const t = todayLocal();
  const since = isoLocal(addDays(t, -29)), until = isoLocal(t);
  const [ins, camps, adsets] = await Promise.all([
    meta.get(token, `${id}/insights`, {
      fields: "spend,actions,account_currency",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: "500",
    }),
    meta.get(token, `${id}/campaigns`, { fields: "id,name,effective_status,daily_budget", effective_status: '["ACTIVE"]', limit: "500" }).catch(() => ({ data: [] })),
    meta.get(token, `${id}/adsets`, { fields: "campaign_id,daily_budget", effective_status: '["ACTIVE"]', limit: "500" }).catch(() => ({ data: [] })),
  ]);
  const map = {}; let currency = "ILS";
  (ins.data || []).forEach((r) => { currency = r.account_currency || currency; map[r.date_start] = { spend: parseFloat(r.spend || 0), leads: leadFrom(r.actions) }; });
  const daily = [];
  for (let d = 29; d >= 0; d--) { const date = isoLocal(addDays(t, -d)); daily.push({ date, spend: (map[date] && map[date].spend) || 0, leads: (map[date] && map[date].leads) || 0 }); }
  const adBud = {};
  (adsets.data || []).forEach((s) => { const cid = s.campaign_id; adBud[cid] = (adBud[cid] || 0) + parseFloat(s.daily_budget || 0); });
  let budMinor = 0;
  (camps.data || []).forEach((c) => { const cdb = parseFloat(c.daily_budget || 0); budMinor += cdb > 0 ? cdb : (adBud[c.id] || 0); });
  return {
    name: acc.name, account: id, currency,
    activeCampaigns: (camps.data || []).length,
    campaignNames: (camps.data || []).map((c) => c.name),
    daily, dailyBudget: budMinor / 100,
    campaigns: null, ads: null, error: null,
  };
}

// ============================================================
// Ad-level detail for one account — powers the "actions" and
// "analysis" pages (server-side equivalent of the old client fetch).
// ============================================================
const adCache = new Map(); // "account|days" -> { at, data }
export async function computeAdDetail(account, days = 7, { force = false } = {}) {
  const id = actId(account);
  const key = id + "|" + days;
  const now = Date.now();
  const hit = adCache.get(key);
  if (!force && hit && (now - hit.at) < TTL_MS) return hit.data;

  const acc = config.accounts.find((a) => actId(a.account) === id) || { account: id };
  const token = tokenFor(acc);
  const t = todayLocal();
  const since = isoLocal(addDays(t, -(days - 1))), until = isoLocal(t);
  const ins = await meta.get(token, `${id}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,actions,impressions,clicks,reach,frequency,cpm,inline_link_clicks",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });

  const g = {};
  (ins.data || []).forEach((r) => {
    const aid = r.ad_id;
    if (!g[aid]) g[aid] = { id: aid, adName: r.ad_name, adsetId: r.adset_id, adsetName: r.adset_name, campaignName: r.campaign_name, campaignId: r.campaign_id, status: "ACTIVE", spend: 0, leads: 0, impressions: 0, clicks: 0, linkClicks: 0, reachMax: 0, days: [] };
    const o = g[aid];
    const sp = parseFloat(r.spend || 0), ld = leadFrom(r.actions);
    o.spend += sp; o.leads += ld;
    o.impressions += parseInt(r.impressions || 0);
    o.clicks += parseInt(r.clicks || 0);
    o.linkClicks += parseInt(r.inline_link_clicks || 0);
    o.reachMax = Math.max(o.reachMax, parseInt(r.reach || 0));
    o.days.push({ date: r.date_start, spend: sp, leads: ld });
  });
  const ads = Object.values(g).map((o) => {
    const linkC = o.linkClicks || o.clicks;
    o.days.sort((a, b) => (a.date < b.date ? -1 : 1));
    const trend = o.days.map((d) => (d.leads > 0 ? d.spend / d.leads : null)).filter((x) => x != null);
    return {
      id: o.id, adName: o.adName, adsetId: o.adsetId, adsetName: o.adsetName,
      campaignName: o.campaignName, campaignId: o.campaignId, status: o.status,
      spend: o.spend, leads: o.leads, impressions: o.impressions, clicks: linkC, reach: o.reachMax,
      frequency: o.reachMax > 0 ? o.impressions / o.reachMax : 0,
      ctr: o.impressions > 0 ? linkC / o.impressions : 0,
      cpm: o.impressions > 0 ? o.spend / o.impressions * 1000 : 0,
      cpl: o.leads > 0 ? o.spend / o.leads : null,
      cplTrend: trend,
    };
  });
  const cmap = {};
  ads.forEach((a) => {
    const k = a.campaignId || a.campaignName;
    if (!cmap[k]) cmap[k] = { id: k, name: a.campaignName, spend: 0, leads: 0, impressions: 0, clicks: 0, reach: 0, adsets: 0, status: "ACTIVE" };
    const c = cmap[k];
    c.spend += a.spend; c.leads += a.leads; c.impressions += a.impressions; c.clicks += a.clicks; c.reach += a.reach; c.adsets++;
  });
  const campaigns = Object.values(cmap).map((c) => ({
    ...c,
    frequency: c.reach > 0 ? c.impressions / c.reach : 1.5,
    ctr: c.impressions > 0 ? c.clicks / c.impressions : 0,
    cpm: c.impressions > 0 ? c.spend / c.impressions * 1000 : 0,
    cpl: c.leads > 0 ? c.spend / c.leads : null,
    cplTrend: [],
  }));
  const data = { ads, campaigns };
  adCache.set(key, { at: now, data });
  return data;
}
