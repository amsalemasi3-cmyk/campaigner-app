// ============================================================
// A/B testing — Bayesian winner decision + orchestrator.
// The math is deterministic (never an LLM): we compare conversion
// rates with a Beta model and only declare a winner past a
// confidence threshold and a minimum sample.
// ============================================================
import { config, tokenFor, accountFromId } from "./config.js";
import { meta } from "./meta.js";
import { store, audit } from "./store.js";
import { execute } from "./executor.js";

// Gamma sampler (Marsaglia & Tsang) → Beta sampler → P(rateB > rateA)
function gamma(k) {
  if (k < 1) return gamma(1 + k) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = Math.random(), u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function betaSample(a, b) { const x = gamma(a), y = gamma(b); return x / (x + y); }

// probability that variant's true rate beats control's (Beta(1,1) prior)
export function probBeats(convA, totA, convB, totB, samples = 20000) {
  const aA = convA + 1, bA = (totA - convA) + 1, aB = convB + 1, bB = (totB - convB) + 1;
  let wins = 0;
  for (let i = 0; i < samples; i++) if (betaSample(aB, bB) > betaSample(aA, bA)) wins++;
  return wins / samples;
}

// decide across N variants (returns {status, winnerIndex, probs})
export function decide(variants, minResults, confidence) {
  // variants: [{conv, tot}]  (conv=leads, tot=clicks or impressions)
  const totalConv = variants.reduce((s, v) => s + v.conv, 0);
  if (totalConv < minResults) return { status: "wait", reason: `נאסף ${totalConv}/${minResults}` };
  // find leader by rate, then test it against the rest pooled
  let best = 0;
  variants.forEach((v, i) => { const r = v.tot ? v.conv / v.tot : 0, rb = variants[best].tot ? variants[best].conv / variants[best].tot : 0; if (r > rb) best = i; });
  const rest = variants.filter((_, i) => i !== best).reduce((a, v) => ({ conv: a.conv + v.conv, tot: a.tot + v.tot }), { conv: 0, tot: 0 });
  const p = probBeats(rest.conv, rest.tot, variants[best].conv, variants[best].tot);
  if (p >= confidence) return { status: "winner", winnerIndex: best, prob: p };
  return { status: "inconclusive", winnerIndex: best, prob: p };
}

// Evaluate all running tests whose window has elapsed.
export async function evaluateAbTests(nowIso) {
  const now = new Date(nowIso).getTime();
  for (const t of store.abtests.filter((x) => x.status === "running")) {
    const elapsedDays = (now - new Date(t.startedIso).getTime()) / 86400000;
    if (elapsedDays < t.decideAfterDays) continue;
    const acc = accountFromId(t.account);
    try {
      let rows = [];
      if (!t.dryRun && !config.dryRun) rows = await meta.adInsightsForAds(tokenFor(acc), t.account, Math.ceil(elapsedDays) + 1);
      // build per-ad variant stats
      const byAd = {};
      rows.forEach((r) => { const conv = leads(r.actions); byAd[r.ad_id] = { conv, tot: parseInt(r.inline_link_clicks || r.impressions || 0) }; });
      const variants = t.adIds.map((id) => byAd[id] || { conv: 0, tot: 0 });
      const d = decide(variants, config.abMinResults, config.abConfidence);
      if (d.status === "wait") { continue; }
      if (d.status === "winner") {
        // pause all losers
        t.adIds.forEach((id, i) => { if (i !== d.winnerIndex) execute({ agent: t.agent, adId: id, adName: "A/B loser", account: t.account, action: { kind: "pause", type: "abtest" } }, { force: false }); });
        t.status = "decided"; t.winner = t.creativeNames[d.winnerIndex]; t.prob = d.prob;
        audit({ agent: t.agent, action: "abtest:decided", executed: !t.dryRun, dryRun: t.dryRun,
          result: `מנצח: ${t.winner} (הסתברות ${Math.round(d.prob * 100)}%) — מפסידנים כובו` });
      } else {
        t.status = "inconclusive";
        audit({ agent: t.agent, action: "abtest:inconclusive", executed: false, why: `אין הכרעה מובהקת (${Math.round((d.prob || 0) * 100)}%)` });
      }
    } catch (e) { store.lastError = e.message; }
  }
}

function leads(actions) {
  if (!actions || !actions.length) return 0;
  const g = (t) => { const x = actions.find((a) => a.action_type === t); return x ? parseFloat(x.value) : null; };
  return g("lead") ?? g("offsite_conversion.fb_pixel_lead") ?? g("onsite_conversion.lead_grouped") ?? 0;
}
