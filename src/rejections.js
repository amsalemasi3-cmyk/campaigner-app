// ============================================================
// Rejection / block handler.
// Detects disapproved ads, and (when enabled) auto-replaces them
// with a fresh creative from the bank — up to a retry limit — or
// alerts a human when it's a policy call. DRY-RUN safe.
// ============================================================
import { config, tokenFor, accountFromId, launchReady } from "./config.js";
import { meta, actId } from "./meta.js";
import { store, audit } from "./store.js";
import { swapCreative } from "./builder.js";

const REJECTED = ["DISAPPROVED", "WITH_ISSUES"];

// Scan an account for ads that Meta rejected / flagged.
export async function scanRejections(account) {
  const acc = accountFromId(typeof account === "string" ? account : account.account);
  const token = tokenFor(acc);
  const j = await meta.get(token, `${actId(acc.account)}/ads`, {
    fields: "id,name,adset_id,campaign_id,effective_status,issues_info",
    effective_status: JSON.stringify(REJECTED),
    limit: "500",
  });
  return (j.data || []).map((a) => ({
    account: acc.account, agent: acc.name || acc.account,
    adId: a.id, adName: a.name, adsetId: a.adset_id, campaignId: a.campaign_id,
    status: a.effective_status,
    issue: (a.issues_info && a.issues_info[0]) ? (a.issues_info[0].error_summary || a.issues_info[0].error_message) : "",
  }));
}

function pickBankCreative(account) {
  const pool = store.creatives.filter((c) => c.status !== "retired");
  pool.sort((a, b) => (b.status === "winner" ? 1 : 0) - (a.status === "winner" ? 1 : 0));
  return pool[0] || null;
}

// Run across all accounts (called from the cycle).
export async function handleRejections() {
  const found = [];
  for (const acc of config.accounts) {
    try { found.push(...await scanRejections(acc)); }
    catch (e) { store.lastError = e.message; }
  }
  store.rejections = found;

  for (const r of found) {
    const tries = store.rejectionRetries[r.adId] || 0;

    // out of retries → hand to a human
    if (tries >= config.rejectionMaxRetries) {
      audit({ agent: r.agent, adId: r.adId, adName: r.adName, action: "rejection:alert", executed: false,
        why: `מודעה נדחתה (${r.issue || r.status}) — עברה את מכסת הניסיונות, דורשת בדיקה ידנית` });
      continue;
    }
    // disabled / dry-run → just log the detection
    if (!config.autoFixRejections || config.dryRun || config.killSwitch || store.killed) {
      audit({ agent: r.agent, adId: r.adId, adName: r.adName, action: "rejection:detected",
        dryRun: config.dryRun, executed: false, why: `נדחתה (${r.issue || r.status})` + (config.autoFixRejections ? "" : " — טיפול אוטומטי כבוי") });
      continue;
    }
    // auto-fix: swap to a different bank creative (changes copy + image → usually clears creative rejections)
    const cr = pickBankCreative(r.account);
    if (!cr) { audit({ agent: r.agent, adId: r.adId, action: "rejection:fix", executed: false, why: "אין קריאטיב חלופי בבנק — מתריע" }); continue; }
    const ready = launchReady(accountFromId(r.account));
    if (!ready.ready) { audit({ agent: r.agent, adId: r.adId, action: "rejection:fix", executed: false, why: "החשבון לא מוכן ליצירה — חסר: " + ready.missing.join(", ") }); continue; }
    try {
      await swapCreative(accountFromId(r.account), { adId: r.adId, adName: r.adName, adsetId: r.adsetId }, cr);
      store.rejectionRetries[r.adId] = tries + 1;
      audit({ agent: r.agent, adId: r.adId, adName: r.adName, action: "rejection:fixed", executed: true,
        result: `מודעה שנדחתה הוחלפה בקריאטיב "${cr.name}" מהבנק (ניסיון ${tries + 1})` });
    } catch (e) { store.lastError = e.message; }
  }
  return found;
}
