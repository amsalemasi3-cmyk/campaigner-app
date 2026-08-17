// ============================================================
// Guardrails — the brakes. Nothing executes unless it passes here.
// ============================================================
import { config } from "./config.js";
import { store } from "./store.js";

// Returns { ok: true } or { ok: false, why: "..." }
export function checkAction(rec) {
  if (config.killSwitch || store.killed) return { ok: false, why: "מתג חירום פעיל (KILL_SWITCH)" };
  if (config.dryRun) return { ok: false, why: "DRY-RUN — המלצה בלבד, לא מבצע" };

  const kind = rec.action.kind;
  if (kind === "pause") {
    if (!config.autoPause) return { ok: false, why: "AUTO_PAUSE כבוי — ממתין לאישור" };
    return { ok: true };
  }
  if (kind === "budget") {
    if (!config.autoBudget) return { ok: false, why: "AUTO_BUDGET כבוי — ממתין לאישור" };
    // change magnitude cap
    const changePct = Math.abs(rec.action.factor - 1) * 100;
    if (changePct > config.maxBudgetChangePct)
      return { ok: false, why: `שינוי ${changePct.toFixed(0)}% חורג מהמקסימום ${config.maxBudgetChangePct}%` };
    return { ok: true };
  }
  return { ok: false, why: "סוג פעולה לא מוכר" };
}

// Enforce the daily budget cap when raising budgets (minor units in → checks major cap)
export function withinBudgetCap(newMinorUnits) {
  const major = newMinorUnits / 100;
  if (major > config.budgetCapDaily)
    return { ok: false, why: `תקציב ${major.toFixed(0)} חורג מהתקרה ${config.budgetCapDaily}` };
  return { ok: true };
}
