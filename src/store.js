// ============================================================
// In-memory state + audit log.
// NOTE: Railway's filesystem is ephemeral, so v1 keeps state in
// memory and logs to console (Railway captures logs). Add a
// Postgres store in the next increment for durable history.
// ============================================================

export const store = {
  recommendations: [],   // latest analysis output
  audit: [],             // every executed / attempted action
  killed: false,         // runtime kill switch (in addition to env)
  lastRun: null,
  lastError: null,
};

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
