// ============================================================
// Executor — performs a single recommendation against Meta,
// but ONLY after guardrails approve. Also used by the manual
// /approve endpoint (which bypasses the auto flags but still
// respects kill-switch + budget cap).
// ============================================================
import { config, tokenFor } from "./config.js";
import { meta } from "./meta.js";
import { store, audit } from "./store.js";
import { withinBudgetCap } from "./guardrails.js";

function accountObj(rec) {
  return config.accounts.find((a) => a.account === rec.account) || { account: rec.account };
}

// force=true → manual approval from dashboard (skips auto flags & dry-run, keeps hard safety)
export async function execute(rec, { force = false } = {}) {
  const base = { agent: rec.agent, adId: rec.adId, adName: rec.adName, action: rec.action.kind + ":" + rec.action.type };

  if (config.killSwitch || store.killed) return audit({ ...base, executed: false, why: "KILL_SWITCH" });
  if (!force && config.dryRun) return audit({ ...base, dryRun: true, why: "DRY-RUN (recommend only)" });

  const token = tokenFor(accountObj(rec));
  try {
    if (rec.action.kind === "pause") {
      await meta.pauseAd(token, rec.adId);
      return audit({ ...base, executed: true, result: "מודעה כובתה" });
    }
    if (rec.action.kind === "budget") {
      const target = rec.adsetId || rec.campaignId;
      const info = await meta.getBudget(token, rec.adsetId || rec.campaignId);
      let id = rec.adsetId, cur = info.daily_budget;
      if (!(cur && +cur > 0) && rec.campaignId) {
        const c = await meta.getBudget(token, rec.campaignId);
        id = rec.campaignId; cur = c.daily_budget;
      }
      if (!(cur && +cur > 0)) return audit({ ...base, executed: false, why: "אין תקציב יומי לעריכה (CBO/lifetime)" });
      const next = Math.max(100, Math.round(+cur * rec.action.factor));
      const cap = withinBudgetCap(next);
      if (!cap.ok) return audit({ ...base, executed: false, why: cap.why });
      await meta.setDailyBudget(token, id, next);
      return audit({ ...base, executed: true, result: `תקציב ${(+cur / 100).toFixed(0)} → ${(next / 100).toFixed(0)}` });
    }
    return audit({ ...base, executed: false, why: "unknown action" });
  } catch (e) {
    store.lastError = e.message;
    return audit({ ...base, executed: false, why: "שגיאה: " + e.message });
  }
}
