// ============================================================
// Optimization engine — the "campaigner brain".
// Turns ad-level insights into concrete recommended actions.
// Same logic as the dashboard, tunable via config thresholds.
// ============================================================
import { config } from "./config.js";
import { meta, leadFrom } from "./meta.js";

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Aggregate raw day-rows into one object per ad
function aggregateAds(rows) {
  const g = {};
  for (const r of rows) {
    const id = r.ad_id;
    if (!g[id])
      g[id] = {
        adId: id, adName: r.ad_name, adsetId: r.adset_id, adsetName: r.adset_name,
        campaignId: r.campaign_id, campaignName: r.campaign_name,
        spend: 0, leads: 0, impressions: 0, clicks: 0, linkClicks: 0, reachMax: 0, days: [],
      };
    const o = g[id];
    const sp = parseFloat(r.spend || 0);
    const ld = leadFrom(r.actions);
    o.spend += sp; o.leads += ld;
    o.impressions += parseInt(r.impressions || 0);
    o.clicks += parseInt(r.clicks || 0);
    o.linkClicks += parseInt(r.inline_link_clicks || 0);
    o.reachMax = Math.max(o.reachMax, parseInt(r.reach || 0));
    o.days.push({ date: r.date_start, spend: sp, leads: ld });
  }
  return Object.values(g).map((o) => {
    const linkC = o.linkClicks || o.clicks;
    return {
      ...o,
      ctr: o.impressions > 0 ? linkC / o.impressions : 0,
      cpm: o.impressions > 0 ? (o.spend / o.impressions) * 1000 : 0,
      cpl: o.leads > 0 ? o.spend / o.leads : null,
      frequency: o.reachMax > 0 ? o.impressions / o.reachMax : 0,
    };
  });
}

// Decide the single action for one ad (or null)
function decide(ad, ctx) {
  const c = config;
  const cpl = ad.cpl, medCpl = ctx.medianCpl;
  // 1. burning budget, no leads
  if (ad.leads === 0 && ad.spend > (medCpl ? medCpl * 2 : 80)) {
    return { kind: "pause", type: "burn", severity: "critical",
      reason: `שורפת ${ad.spend.toFixed(0)} ללא לידים` };
  }
  // 2. weak creative (low CTR) — stop the bleed (auto-replace comes with creative bank)
  if (ad.impressions > c.minImpressionsForCreative && ad.ctr > 0 && ad.ctr < c.ctrLow) {
    return { kind: "pause", type: "creative", severity: "high",
      reason: `CTR ${(ad.ctr * 100).toFixed(2)}% — קריאטיב חלש` };
  }
  // 3. fatigue
  if (ad.frequency >= c.freqHigh) {
    return { kind: "pause", type: "fatigue", severity: "high",
      reason: `תדירות ${ad.frequency.toFixed(1)} — עייפות קהל` };
  }
  // 4. expensive CPL → reduce budget
  if (cpl != null && medCpl && cpl > medCpl * c.cplExpensiveMult) {
    return { kind: "budget", factor: c.budgetDownFactor, type: "expensive", severity: "high",
      reason: `עלות לליד ${cpl.toFixed(0)} — פי ${(cpl / medCpl).toFixed(1)} מהחציון` };
  }
  // 5. winner → raise budget
  if (cpl != null && medCpl && cpl < medCpl * c.cplWinnerMult && ad.leads >= 5 && ad.frequency < 2) {
    return { kind: "budget", factor: c.budgetUpFactor, type: "scale", severity: "opportunity",
      reason: `מנצחת: עלות לליד ${cpl.toFixed(0)}, תדירות בריאה` };
  }
  return null;
}

// Analyze one account → list of recommendations
export async function analyzeAccount(account) {
  const token = (account.token && account.token.trim()) || config.metaToken;
  const rows = await meta.adInsights(token, account.account, config.windowDays);
  const ads = aggregateAds(rows);
  const cpls = ads.filter((a) => a.cpl != null).map((a) => a.cpl);
  const ctx = { medianCpl: median(cpls) };
  const recs = [];
  for (const ad of ads) {
    const d = decide(ad, ctx);
    if (!d) continue;
    if (ad.leads < config.minLeadsBeforeAction && d.type !== "burn") continue; // min-data guard
    recs.push({
      id: `${ad.adId}:${d.type}`,
      agent: account.name, account: account.account,
      adId: ad.adId, adName: ad.adName, adsetId: ad.adsetId, adsetName: ad.adsetName,
      campaignId: ad.campaignId, campaignName: ad.campaignName,
      metrics: { spend: ad.spend, leads: ad.leads, cpl: ad.cpl, ctr: ad.ctr, frequency: ad.frequency, cpm: ad.cpm },
      action: d,
    });
  }
  return recs;
}
