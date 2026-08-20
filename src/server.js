// ============================================================
// Autonomous Campaigner — server entry point.
// - Runs an analysis cycle on a schedule (node-cron)
// - Executes actions that pass guardrails (or dry-runs them)
// - Exposes a small API the dashboard can read / approve / stop
// ============================================================
import express from "express";
import cron from "node-cron";
import { config, launchReady, accountFromId } from "./config.js";
import { analyzeAccount } from "./engine.js";
import { checkAction } from "./guardrails.js";
import { execute } from "./executor.js";
import { store, setRecommendations, audit, addCreative, removeCreative, setLaunchConfig } from "./store.js";
import { swapCreative, launchABTest } from "./builder.js";
import { evaluateAbTests } from "./abtest.js";
import { meta, actId } from "./meta.js";
import { launchCfg, tokenFor, llmReady } from "./config.js";
import { generateCopy } from "./llm.js";
import { handleRejections, scanRejections } from "./rejections.js";
import { computeSummary, computeAgentsData, computeAdDetail } from "./summary.js";

// fields the dashboard is allowed to read / change at runtime
const TUNABLE = [
  "dryRun", "autoPause", "autoBudget", "autoSwap", "autoCreate", "windowDays",
  "budgetCapDaily", "maxBudgetChangePct", "minLeadsBeforeAction", "minImpressionsForCreative",
  "ctrLow", "freqHigh", "cplExpensiveMult", "cplWinnerMult", "budgetDownFactor", "budgetUpFactor",
  "abTestDays", "abMinResults", "abConfidence",
  "autoFixRejections", "rejectionMaxRetries",
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

    // auto-swap: fatigued / weak-creative → replace from the bank (same adset)
    if (config.autoSwap && (rec.action.type === "creative" || rec.action.type === "fatigue")) {
      const cr = pickBankCreative(rec.account);
      if (cr) { try { await swapCreative(accountFromId(rec.account), { adId: rec.adId, adName: rec.adName, adsetId: rec.adsetId }, cr); } catch (e) { store.lastError = e.message; } }
      else audit({ agent: rec.agent, adId: rec.adId, action: "swap", executed: false, why: "אין קריאטיב פנוי בבנק להחלפה" });
    }
  }

  // evaluate any running A/B tests whose window elapsed
  try { await evaluateAbTests(new Date().toISOString()); } catch (e) { store.lastError = e.message; }
  // detect & handle rejected / blocked ads
  try { await handleRejections(); } catch (e) { store.lastError = e.message; }

  console.log(`=== cycle done · ${all.length} recommendations ===`);
}

// pick a "ready" bank creative for an account (not retired), preferring winners
function pickBankCreative(account) {
  const pool = store.creatives.filter((c) => c.status !== "retired");
  pool.sort((a, b) => (a.status === "winner" ? -1 : 0) - (b.status === "winner" ? -1 : 0));
  return pool[0] || null;
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

// ---- dashboard login (open, no key) ----
// If ADMIN_USER + ADMIN_PASS are set, the dashboard logs in against the SERVER,
// and on success receives the API key — so the same credentials work on every
// device and settings never live in one browser.
const serverAuthEnabled = () => !!(config.adminUser && config.adminPass);
app.get("/api/auth-mode", (_req, res) => res.json({ serverAuth: serverAuthEnabled() }));
app.post("/api/login", express.json(), (req, res) => {
  if (!serverAuthEnabled()) return res.json({ ok: false, serverAuth: false });
  const { user, pass } = req.body || {};
  if (String(user) === config.adminUser && String(pass) === config.adminPass) {
    return res.json({ ok: true, apiKey: config.apiKey });
  }
  return res.status(401).json({ ok: false, error: "bad credentials" });
});

// Everything else under /api requires the shared-secret header.
const api = express.Router();
api.use((req, res, next) => {
  const key = req.get("x-api-key");
  if (key !== config.apiKey) return res.status(401).json({ error: "unauthorized" });
  next();
});

api.get("/status", (_req, res) => res.json({
  dryRun: config.dryRun, killed: store.killed || config.killSwitch,
  autoPause: config.autoPause, autoBudget: config.autoBudget,
  autoSwap: config.autoSwap, autoCreate: config.autoCreate, autoFixRejections: config.autoFixRejections,
  llmReady: llmReady(), rejections: store.rejections.length,
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

// creative bank (now also holds the fields needed to BUILD an ad)
api.get("/creatives", (_req, res) => res.json(store.creatives));
api.post("/creatives", (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "name required" });
  res.json(addCreative({
    name: String(b.name).slice(0, 120), angle: b.angle || "", format: b.format || "",
    audience: b.audience || "", note: b.note || "", status: b.status || "ready",
    // build fields
    assetType: b.assetType || "image", assetUrl: b.assetUrl || b.url || "", videoId: b.videoId || "",
    headline: b.headline || "", primaryText: b.primaryText || "", description: b.description || "",
    ctaType: b.ctaType || "", linkUrl: b.linkUrl || "", url: b.url || "",
  }));
});
api.delete("/creatives/:id", (req, res) => res.json({ removed: removeCreative(req.params.id) }));

// creation readiness per account (what Meta fields are missing)
api.get("/launch-status", (_req, res) => res.json(config.accounts.map((a) => ({ name: a.name, account: a.account, ...launchReady(a) }))));

// full per-account launch profiles (for the "creation settings" screen)
api.get("/accounts", (_req, res) => res.json(config.accounts.map((a) => ({
  name: a.name, account: a.account, launch: launchCfg(a), ...launchReady(a),
}))));
// save a per-account launch profile from the UI
api.put("/launch-config", (req, res) => {
  const b = req.body || {};
  if (!b.account) return res.status(400).json({ error: "account required" });
  setLaunchConfig(b.account, b.patch || {});
  const a = accountFromId(b.account);
  res.json({ account: b.account, launch: launchCfg(a), ...launchReady(a) });
});
// auto-detect the pixel(s) and page(s) attached to an account
api.get("/discover", async (req, res) => {
  const acc = accountFromId(req.query.account);
  const token = tokenFor(acc);
  try {
    const out = { pixels: [], pages: [] };
    try { const px = await meta.get(token, `${actId(acc.account)}/adspixels`, { fields: "id,name" }); out.pixels = px.data || []; } catch (e) { out.pixelError = e.message; }
    try { const pg = await meta.get(token, `${actId(acc.account)}/promote_pages`, { fields: "id,name" }); out.pages = pg.data || []; } catch (e) { /* pages optional */ }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// manually launch an A/B test from bank creatives
api.post("/launch", async (req, res) => {
  const b = req.body || {};
  const acc = accountFromId(b.account);
  const creatives = (b.creativeIds || []).map((id) => store.creatives.find((c) => c.id === id)).filter(Boolean);
  if (!creatives.length) return res.status(400).json({ error: "no valid creatives" });
  try { res.json(await launchABTest(acc, { name: b.name, creatives, dailyBudgetMinor: b.dailyBudgetMinor })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// manual creative swap on a specific ad
api.post("/swap", async (req, res) => {
  const b = req.body || {};
  const cr = store.creatives.find((c) => c.id === b.creativeId);
  if (!cr) return res.status(400).json({ error: "creative not found" });
  try { res.json(await swapCreative(accountFromId(b.account), { adId: b.adId, adsetId: b.adsetId, adName: b.adName }, cr)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
api.get("/abtests", (_req, res) => res.json(store.abtests));

// LLM copywriter — generate variations, optionally add to the bank
api.get("/llm-status", (_req, res) => res.json({ ready: llmReady() }));
api.post("/copy/generate", async (req, res) => {
  try {
    const vars = await generateCopy(req.body || {});
    if (req.body && req.body.addToBank) {
      const shared = { assetType: req.body.assetType || "image", assetUrl: req.body.assetUrl || "", url: req.body.assetUrl || "",
        linkUrl: req.body.linkUrl || "", ctaType: req.body.ctaType || "", status: "ready", angle: req.body.angle || "", source: "ai" };
      const added = vars.map((v, i) => addCreative({ name: (req.body.namePrefix || "AI קופי") + " " + (i + 1), headline: v.headline, primaryText: v.primaryText, ...shared }));
      return res.json({ variations: vars, added });
    }
    res.json({ variations: vars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// rejections
api.get("/rejections", (_req, res) => res.json(store.rejections));
api.post("/rejections/scan", async (_req, res) => {
  try {
    const found = [];
    for (const acc of config.accounts) { try { found.push(...await scanRejections(acc)); } catch (e) { /* per-account */ } }
    store.rejections = found;
    res.json(found);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// per-agent snapshot for the mobile page (cached ~2 min)
api.get("/summary", async (req, res) => {
  try { res.json(await computeSummary(req.query.range || "7d", { force: req.query.force === "1" })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// full 30-day per-agent series for the main dashboard (overview / agents / charts)
api.get("/agents-data", async (req, res) => {
  try { res.json(await computeAgentsData({ force: req.query.force === "1" })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ad-level detail for one account (actions / analysis pages)
api.get("/ad-detail", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "7", 10));
    res.json(await computeAdDetail(req.query.account, days, { force: req.query.force === "1" }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- manual (user-initiated) writes from the dashboard action cards ----
// These are explicit clicks (not the autonomous cycle), so they write directly.
api.post("/manual/pause", async (req, res) => {
  const { account, adId } = req.body || {};
  if (!adId) return res.status(400).json({ error: "adId required" });
  try {
    const acc = accountFromId(account); const token = tokenFor(acc);
    await meta.pauseAd(token, adId);
    audit({ agent: (acc && acc.name) || account, adId, action: "manual:pause", executed: true, why: "מהדשבורד" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
api.post("/manual/budget", async (req, res) => {
  const { account, adsetId, campaignId, factor } = req.body || {};
  const f = parseFloat(factor) || 1;
  try {
    const acc = accountFromId(account); const token = tokenFor(acc);
    const tryOn = async (id, level) => {
      const info = await meta.getBudget(token, id);
      const cur = parseFloat(info && info.daily_budget || 0);
      if (cur > 0) {
        const nb = Math.max(100, Math.round(cur * f));
        await meta.setDailyBudget(token, id, nb);
        return { from: cur, to: nb, level };
      }
      return null;
    };
    let out = null;
    if (adsetId) out = await tryOn(adsetId, "אד-סט");
    if (!out && campaignId) out = await tryOn(campaignId, "קמפיין");
    if (!out) return res.status(400).json({ error: "אין תקציב יומי לעריכה (CBO/lifetime)" });
    audit({ agent: (acc && acc.name) || account, adId: adsetId || campaignId, action: "manual:budget", executed: true, why: `${out.from}→${out.to}` });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
