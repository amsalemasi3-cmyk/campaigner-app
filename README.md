# Autonomous Campaigner — App (dashboard + brain, one deploy)

**One application:** it serves the **dashboard** at `/` (open the URL and it's there) and runs the **autonomous brain** behind it — pulling Meta ad performance on a schedule, analyzing every ad, and executing smart data-driven actions (pause / budget) within guardrails. Ships **DRY-RUN by default** — it only *recommends* until you turn execution on.

You deploy it once to Railway, generate a domain, and open that domain — the dashboard loads, and the brain works 24/7 in the background.

---

## What it does now

- Every 30 min (configurable): reads ad-level insights for all your accounts.
- Runs the campaigner rules: burners, weak creatives, fatigue, expensive CPL, winners.
- Produces a ranked list of recommended actions.
- **DRY-RUN:** logs recommendations, changes nothing.
- **When you flip it on:** auto-pauses / adjusts budgets — but only inside guardrails (budget cap, max change %, kill switch).
- Small API so the dashboard can read recommendations, approve one manually, or hit the emergency stop.

## Safety model (read this)

1. `DRY_RUN=true` at first — nothing is executed. Watch the logs, confirm the recommendations are right.
2. Then enable **one** lever at a time: `AUTO_PAUSE=true` (safest — pausing is reversible) before `AUTO_BUDGET=true`.
3. Guardrails always apply: `BUDGET_CAP_DAILY`, `MAX_BUDGET_CHANGE_PCT`, and the `/kill` emergency stop.
4. Every action is written to the audit log (`GET /audit`) and the server console (Railway captures it).

> Production note: managing many client accounts via the API needs **Advanced Access** to `ads_management` (Meta App Review + Business Verification). On your own accounts in Development mode you can start now.

---

## Deploy to Railway (no coding needed)

1. Put this folder in a **GitHub repo** (create a repo, upload these files). *Never commit real tokens.*
2. Go to **railway.app** → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. Railway detects Node and runs `npm start` automatically.
4. Open the service → **Variables** → add everything from `.env.example` with your real values.
   - Most important: `META_TOKEN` (with `ads_management`), `ACCOUNTS`, `API_KEY`.
   - Leave `DRY_RUN=true` for the first days.
5. **Generate a domain:** service → **Settings** → **Networking** → **Generate Domain**. That's your app URL.
6. **Open the domain** → the **dashboard loads** (index). The brain runs behind it on schedule.
   - Sanity check: `https://<your-domain>/health` → `{ "ok": true, "dryRun": true }`.
   - Watch **Deploy Logs** — each cycle prints its recommendations.

When you're confident: set `DRY_RUN=false` and `AUTO_PAUSE=true` in Variables and redeploy. Watch the audit log.

## The brain (smart decisions from data — no creative generation)

The decision engine (`src/engine.js`) is the agent's brain. It turns ad-level data into concrete actions using tunable thresholds (in Variables): burners → pause, weak creative/fatigue → pause, expensive CPL → cut budget, winners → scale. To make it sharper for your niche you just tune the threshold variables — and the next increment adds a **Bayesian A/B significance test** and an optional **LLM reasoning pass** (explains *why* and prioritizes) on top of the deterministic core.

## API (dashboard ↔ brain; send header `x-api-key: <your API_KEY>`)

| Method | Path | What |
|---|---|---|
| GET | `/health` | liveness (no key needed) |
| GET | `/api/status` | mode, flags, last run |
| GET | `/api/actions` | current recommendations |
| GET | `/api/audit` | recent actions log |
| POST | `/api/run` | run a cycle now |
| POST | `/api/actions/:id/approve` | execute one recommendation (manual approve) |
| POST | `/api/kill` | emergency stop |
| POST | `/api/resume` | resume |

## Run locally (optional)

```
npm install
cp .env.example .env   # fill in real values
npm start
```

## Roadmap (next increments)

- **Wire dashboard → brain:** the dashboard reads `/api/actions` and `/api/audit` so it shows the server's recommendations and approvals happen in the UI (one shared brain).
- **Bayesian A/B + smarter decisions:** statistical significance and an optional LLM reasoning pass on top of the deterministic engine — sharper decisions, no creative generation.
- **Durable store:** add Postgres for full history + the learning loop (track outcomes of each decision).
