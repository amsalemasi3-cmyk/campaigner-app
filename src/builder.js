// ============================================================
// Builder — CREATE campaigns, adsets, ads, and creatives on Meta.
// Everything is gated by DRY_RUN: when dry, it logs the exact plan
// and returns simulated ids instead of calling the API. Nothing
// spends money until you set DRY_RUN=false AND the account is
// launch-ready (page/pixel/link configured).
// ============================================================
import { config, tokenFor, launchCfg, launchReady } from "./config.js";
import { meta, actId } from "./meta.js";
import { store, audit, addAbTest } from "./store.js";

function accountObj(account) {
  return (typeof account === "object") ? account : (config.accounts.find((a) => a.account === account) || { account });
}

// Build the object_story_spec for a creative from a bank entry.
function storySpec(l, creative) {
  const link = creative.linkUrl || l.linkUrl;
  const cta = { type: creative.ctaType || l.ctaType, value: { link } };
  if (creative.assetType === "video" && creative.videoId) {
    return { page_id: l.pageId, video_data: {
      video_id: creative.videoId, message: creative.primaryText || "", title: creative.headline || creative.name,
      call_to_action: cta, ...(creative.imageUrl ? { image_url: creative.imageUrl } : {}) } };
  }
  // default: image/link ad using an image URL (no upload needed)
  return { page_id: l.pageId, link_data: {
    link, message: creative.primaryText || "", name: creative.headline || creative.name,
    description: creative.description || "", picture: creative.assetUrl || creative.imageUrl || undefined,
    call_to_action: cta } };
}

function defaultTargeting(l) {
  return { geo_locations: { countries: l.countries }, age_min: l.ageMin, age_max: l.ageMax,
    publisher_platforms: ["facebook", "instagram"] };
}

// ---- low level creators (dry-run aware) ----
async function create(kind, account, path, params) {
  const acc = accountObj(account), token = tokenFor(acc);
  if (config.dryRun || config.killSwitch || store.killed) {
    audit({ agent: acc.name || acc.account, action: "create:" + kind, dryRun: config.dryRun, executed: false,
      why: (config.dryRun ? "DRY-RUN — " : "KILL — ") + "would create " + kind, plan: params });
    return { id: "DRYRUN_" + kind + "_" + Math.floor(Date.now() / 1000) };
  }
  const res = await meta.post(token, path, params);
  audit({ agent: acc.name || acc.account, action: "create:" + kind, executed: true, result: kind + " " + (res.id || "") });
  return res;
}

export async function createCampaign(account, { name, objective }) {
  const l = launchCfg(account);
  return create("campaign", account, `${actId(accountObj(account).account)}/campaigns`, {
    name, objective: objective || l.objective, status: "PAUSED", special_ad_categories: JSON.stringify([]),
  });
}
export async function createAdSet(account, { name, campaignId, dailyBudgetMinor }) {
  const l = launchCfg(account);
  const params = { name, campaign_id: campaignId, daily_budget: String(dailyBudgetMinor || l.dailyBudgetMinor),
    billing_event: l.billingEvent, optimization_goal: l.optimizationGoal, status: "PAUSED",
    targeting: JSON.stringify(defaultTargeting(l)) };
  if (l.optimizationGoal === "OFFSITE_CONVERSIONS" && l.pixelId)
    params.promoted_object = JSON.stringify({ pixel_id: l.pixelId, custom_event_type: l.customEventType });
  return create("adset", account, `${actId(accountObj(account).account)}/adsets`, params);
}
export async function createCreative(account, creative) {
  const l = launchCfg(account);
  return create("creative", account, `${actId(accountObj(account).account)}/adcreatives`, {
    name: creative.name || "creative", object_story_spec: JSON.stringify(storySpec(l, creative)),
  });
}
export async function createAd(account, { name, adsetId, creativeId, activate }) {
  return create("ad", account, `${actId(accountObj(account).account)}/ads`, {
    name, adset_id: adsetId, creative: JSON.stringify({ creative_id: creativeId }),
    status: activate ? "ACTIVE" : "PAUSED",
  });
}

// ---- high level ----

// Build a new ad in an EXISTING adset from a bank creative (core of auto-swap).
export async function buildAdFromCreative(account, creative, adsetId, { activate = false } = {}) {
  const cr = await createCreative(account, creative);
  const ad = await createAd(account, { name: "AUTO · " + (creative.name || "ad"), adsetId, creativeId: cr.id, activate });
  return { creativeId: cr.id, adId: ad.id };
}

// Replace a losing ad: build a fresh ad from a bank creative in the same adset, then pause the loser.
export async function swapCreative(account, losingAd, creative) {
  const acc = accountObj(account);
  const ready = launchReady(acc);
  if (!ready.ready) {
    audit({ agent: acc.name || acc.account, action: "swap", executed: false, why: "החשבון לא מוכן ליצירה — חסר: " + ready.missing.join(", ") });
    return { ok: false, missing: ready.missing };
  }
  const built = await buildAdFromCreative(acc, creative, losingAd.adsetId, { activate: !config.dryRun });
  // pause the loser (respects dry-run inside executor path)
  if (!(config.dryRun || config.killSwitch || store.killed)) {
    try { await meta.pauseAd(tokenFor(acc), losingAd.adId || losingAd.id); } catch (e) { store.lastError = e.message; }
  }
  audit({ agent: acc.name || acc.account, action: "swap", dryRun: config.dryRun, executed: !config.dryRun,
    result: `החלפת קריאטיב: כבה ${losingAd.adName || losingAd.adId} → מודעה חדשה מ"${creative.name}"` });
  return { ok: true, ...built };
}

// Launch a fresh campaign as an A/B test: one adset, N ads (one per creative).
export async function launchABTest(account, { name, creatives, dailyBudgetMinor }) {
  const acc = accountObj(account);
  const ready = launchReady(acc);
  if (!ready.ready) return { ok: false, missing: ready.missing };
  if (!creatives || creatives.length < 1) return { ok: false, error: "need at least 1 creative" };
  const camp = await createCampaign(acc, { name: name || "AUTO A/B " });
  const adset = await createAdSet(acc, { name: (name || "A/B") + " · adset", campaignId: camp.id, dailyBudgetMinor });
  const ads = [];
  for (const cr of creatives) {
    const b = await buildAdFromCreative(acc, cr, adset.id, { activate: !config.dryRun });
    ads.push({ adId: b.adId, creativeName: cr.name });
  }
  const test = addAbTest({
    account: acc.account, agent: acc.name || acc.account, campaignId: camp.id, adsetId: adset.id,
    adIds: ads.map((a) => a.adId), creativeNames: ads.map((a) => a.creativeName),
    startedIso: new Date().toISOString(), decideAfterDays: config.abTestDays, status: "running", dryRun: config.dryRun,
  });
  audit({ agent: acc.name || acc.account, action: "launch:abtest", dryRun: config.dryRun, executed: !config.dryRun,
    result: `A/B נבנה: קמפיין ${camp.id}, ${ads.length} מודעות` });
  return { ok: true, testId: test.id, campaignId: camp.id, adsetId: adset.id, ads };
}
