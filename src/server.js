// ============================================================
// Autonomous Campaigner — server entry point.
// - Runs an analysis cycle on a schedule (node-cron)
// - Executes actions that pass guardrails (or dry-runs them)
// - Exposes a small API the dashboard can read / approve / stop
// ============================================================
import express from "express";
import cron from "node-cron";
import { config } from "./config.js";
import { analyzeAccount } from "./engine.js";
import { checkAction } from "./guardrails.js";
import { execute } from "./executor.js";
import { store, setRecommendations, audit, addCreative, removeCreative } from "./store.js";

// fields the dashboard is allowed to read / change at runtime
const TUNABLE = [
  "dryRun", "autoPause", "autoBudget", "windowDays",
  "budgetCapDaily", "maxBudgetChangePct", "minLeadsBeforeAction", "minImpressionsForCreative",
  "ctrLow", "freqHigh", "cplExpensiveMult", "cplWinnerMult", "budgetDownFactor", "budgetUpFactor",
];
function readConfig() { const o = {}; for (const k of TUNABLE) o[k] = config[k]; return o; }
function writeConfig(patch) {
  for (const k of TUNABLE) {
    if (patch[k] === undefined) continue;
    if (typeof config[k] === "boolean") config[k] = !!patch[k];
    else { const n = parseFloat(patch[k]); if (Number.isFinite(n)) config[k] = n; }
  }
  return readConfig();
}

// ---- one full cycle: analyze all accounts → act ----
export async function runCycle() {
  if (config.killSwitch || store.killed) { console.log("KILL_SWITCH on — skipping cycle."); return; }
  console.log(`\n=== cycle @ ${new Date().toISOString()} · dryRun=${config.dryRun} ===`);
  const all = [];
  for (const acc of config.accounts) {
    try {
      const recs = await analyzeAccount(acc);
      all.push(...recs);
    } catch (e) {
      store.lastError = e.message;
      console.error(`account ${acc.name} failed: ${e.message}`);
    }
  }
  // rank: critical → high → opportunity, then by spend
  const ord = { critical: 3, high: 2, opportunity: 1 };
  all.sort((a, b) => (ord[b.action.severity] - ord[a.action.severity]) || (b.metrics.spend - a.metrics.spend));
  setRecommendations(all);

  // act on each (guardrails decide; dry-run logs only)
  for (const rec of all) {
    const g = checkAction(rec);
    if (g.ok) await execute(rec);
    else audit({ agent: rec.agent, adId: rec.adId, adName: rec.adName,
      action: rec.action.kind + ":" + rec.action.type, dryRun: config.dryRun, executed: false, why: g.why });
  }
  console.log(`=== cycle done · ${all.length} recommendations ===`);
}

// ---- APP: one server that serves the dashboard AND the API ----
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Serve the dashboard (public/index.html) at "/" — this is the app you open.
app.use(express.static(path.join(__dirname, "..", "public")));

// health is open (no key)
app.get("/health", (_req, res) => res.json({ ok: true, dryRun: config.dryRun, killed: store.killed || config.killSwitch }));

// Everything under /api requires the shared-secret header.
const api = express.Router();
api.use((req, res, next) => {
  const key = req.get("x-api-key");
  if (key !== config.apiKey) return res.status(401).json({ error: "unauthorized" });
  next();
});

api.get("/status", (_req, res) => res.json({
  dryRun: config.dryRun, killed: store.killed || config.killSwitch,
  autoPause: config.autoPause, autoBudget: config.autoBudget,
  accounts: config.accounts.length, lastRun: store.lastRun, lastError: store.lastError,
  openRecommendations: store.recommendations.length,
}));
api.get("/actions", (_req, res) => res.json(store.recommendations));
api.get("/audit", (_req, res) => res.json(store.audit.slice(0, 200)));
api.post("/actions/:id/approve", async (req, res) => {
  const rec = store.recommendations.find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const row = await execute(rec, { force: true });
  res.json(row);
});
api.post("/run", async (_req, res) => { await runCycle(); res.json({ ok: true, recommendations: store.recommendations.length }); });
api.post("/kill", (_req, res) => { store.killed = true; res.json({ killed: true }); });
api.post("/resume", (_req, res) => { store.killed = false; res.json({ killed: false }); });

// runtime rules/autonomy config
api.get("/config", (_req, res) => res.json(readConfig()));
api.put("/config", (req, res) => res.json(writeConfig(req.body || {})));

// creative bank
api.get("/creatives", (_req, res) => res.json(store.creatives));
api.post("/creatives", (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "name required" });
  res.json(addCreative({
    name: String(b.name).slice(0, 120), angle: b.angle || "", format: b.format || "",
    audience: b.audience || "", url: b.url || "", note: b.note || "", status: b.status || "ready",
  }));
});
api.delete("/creatives/:id", (req, res) => res.json({ removed: removeCreative(req.params.id) }));

app.use("/api", api);

app.listen(config.port, () => {
  console.log(`🚀 Autonomous Campaigner on :${config.port}`);
  console.log(`   accounts=${config.accounts.length} · dryRun=${config.dryRun} · autoPause=${config.autoPause} · autoBudget=${config.autoBudget}`);
  if (!config.metaToken && !config.accounts.some((a) => a.token))
    console.warn("⚠️  No META_TOKEN set — analysis will fail until you add one.");
  // schedule
  cron.schedule(config.cron, () => runCycle().catch((e) => console.error(e)));
  console.log(`   scheduled: ${config.cron}`);
  // first run shortly after boot
  setTimeout(() => runCycle().catch((e) => console.error(e)), 4000);
});
