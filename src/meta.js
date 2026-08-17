// ============================================================
// Meta Marketing API client (Node 18+ has global fetch)
// ============================================================
import { config } from "./config.js";

const GRAPH = "https://graph.facebook.com";

function pad(n) { return String(n).padStart(2, "0"); }
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function actId(account) {
  const s = String(account || "").trim();
  const m = s.match(/act[_=]?(\d{4,})/i) || s.match(/(\d{6,})/);
  return "act_" + (m ? m[1] : s.replace(/\D/g, ""));
}

async function call(token, path, { method = "GET", params = {} } = {}) {
  const usp = new URLSearchParams({ ...params, access_token: token });
  let url = `${GRAPH}/${config.apiVer}/${path}`;
  const opt = { method };
  if (method === "GET") url += "?" + usp.toString();
  else opt.body = usp;
  const res = await fetch(url, opt);
  const j = await res.json();
  if (j.error) {
    const e = j.error;
    const err = new Error(`Meta [${e.code}] ${e.message}`);
    err.code = e.code;
    throw err;
  }
  return j;
}

export function leadFrom(actions, mode = config.leadTypeMode, custom = config.leadCustom) {
  if (!actions || !actions.length) return 0;
  const g = (t) => {
    const x = actions.find((a) => a.action_type === t);
    return x ? parseFloat(x.value) : null;
  };
  if (mode === "pixel") return g("offsite_conversion.fb_pixel_lead") ?? 0;
  if (mode === "custom" && custom) return g(custom) ?? 0;
  return g("lead") ?? g("offsite_conversion.fb_pixel_lead") ?? g("onsite_conversion.lead_grouped") ?? 0;
}

export const meta = {
  // Ad-level insights, day by day, for a look-back window
  async adInsights(token, account, days) {
    const j = await call(token, `${actId(account)}/insights`, {
      params: {
        level: "ad",
        fields:
          "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,actions,impressions,clicks,reach,frequency,cpm,inline_link_clicks",
        time_increment: "1",
        time_range: JSON.stringify({ since: isoDaysAgo(days - 1), until: isoDaysAgo(0) }),
        limit: "500",
      },
    });
    return j.data || [];
  },
  async pauseAd(token, adId) {
    return call(token, adId, { method: "POST", params: { status: "PAUSED" } });
  },
  async getBudget(token, id) {
    return call(token, id, { params: { fields: "daily_budget,lifetime_budget,name,status" } });
  },
  async setDailyBudget(token, id, minorUnits) {
    return call(token, id, { method: "POST", params: { daily_budget: String(minorUnits) } });
  },
};
