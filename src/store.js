// ============================================================
// In-memory state + audit log.
// NOTE: Railway's filesystem is ephemeral, so v1 keeps state in
// memory and logs to console (Railway captures logs). Add a
// Postgres store in the next increment for durable history.
// ============================================================

export const store = {
  recommendations: [],   // latest analysis output
  audit: [],             // every executed / attempted action
  creatives: [],         // creative bank entries
  abtests: [],           // running / decided A/B tests
  launchConfigs: {},     // per-account launch profile overrides (keyed by account id)
  rejections: [],        // ads Meta rejected/flagged (last scan)
  rejectionRetries: {},  // adId → attempts count
  killed: false,         // runtime kill switch (in addition to env)
  lastRun: null,
  lastError: null,
};

export function setLaunchConfig(accountId, patch) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  store.launchConfigs[id] = { ...(store.launchConfigs[id] || {}), ...(patch || {}) };
  return store.launchConfigs[id];
}

let _tid = 1;
export function addAbTest(t) {
  const row = { id: "ab" + _tid++, ...t };
  store.abtests.unshift(row);
  if (store.abtests.length > 500) store.abtests.length = 500;
  return row;
}

let _cid = 1;
export function addCreative(c) {
  const row = { id: "cr" + _cid++, createdAt: new Date().toISOString(), ...c };
  store.creatives.unshift(row);
  return row;
}
export function removeCreative(id) {
  const i = store.creatives.findIndex((c) => c.id === id);
  if (i >= 0) store.creatives.splice(i, 1);
  return i >= 0;
}

export function setRecommendations(recs) {
  store.recommendations = recs;
  store.lastRun = new Date().toISOString();
}

export function audit(entry) {
  const row = { ts: new Date().toISOString(), ...entry };
  store.audit.unshift(row);
  if (store.audit.length > 1000) store.audit.length = 1000;
  const tag = entry.executed ? "EXECUTED" : entry.dryRun ? "DRY-RUN" : "SKIPPED";
  console.log(`[${tag}] ${entry.action} · ${entry.agent} · ${entry.adName || entry.adId} · ${entry.why || entry.result || ""}`);
  return row;
}
