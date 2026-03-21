---
name: clawhub
description: >-
  DanceTempo / DanceTech Protocol — full repo context via public/llm-full.txt (or /llm-full.txt),
  tribal debugging via CLAWHUB.md, Tempo + MPP/x402 patterns, dance-extras live routes, EVVM on
  Tempo testnet. Use when: (1) Onboarding an agent or pasting system context, (2) Debugging 402/MPP,
  stale API, or port 8787 issues, (3) Editing docs that feed llm-full.txt, (4) Working on hub routes,
  server/index.js, or integrations (AgentMail, purl, OpenAI MPP, etc.), (5) EVVM deploy/docs,
  (6) Preparing a ClawHub or Copilot instruction bundle, (7) MPPScan/OpenAPI discovery at
  GET /openapi.json, (8) OpenClaw runtime — optional **@anyway-sh/anyway-openclaw** plugin
  (`openclaw plugins install @anyway-sh/anyway-openclaw`). For raw EVVM protocol depth, fetch
  https://www.evvm.info/llms-full.txt (not vendored in-repo).
metadata: {}
---

# DanceTempo · ClawHub context skill

**DanceTempo** is the reference **DanceTech Protocol** superapp: React hub + dedicated routes, Node/Express API, **Tempo** settlement, **MPP / x402** machine payments. This skill tells agents **where context lives** and **how to avoid known traps** (see `CLAWHUB.md`).

---

## Quick reference

| Situation | Action |
| --- | --- |
| Need **one file** with README + use cases + protocol + ClawHub | Load **`public/llm-full.txt`** or **`/llm-full.txt`** (running app). |
| **`402` / MPP / wallet** confusion | **`CLAWHUB.md`** + relevant route in **`server/index.js`**. |
| **UI works but API 404 / HTML** | Backend not running or **stale** process — restart **`npm run server`** (**`8787`**). |
| Verify live MPP handler exists | **`GET http://localhost:8787/api/dance-extras/live`** → JSON with `flowKeys`. |
| **Which screens exist** | **`src/hubRoutes.ts`**; hub **`/`**. |
| **Changed markdown** included in bundle | **`npm run build:llm`** (runs before **`npm run build`**). |
| **EVVM** (deploy, CLI, Tempo testnet) | **`docs/EVVM_TEMPO.md`**, **`/evvm`**; deep: **`https://www.evvm.info/llms-full.txt`**. |
| **MPPScan / OpenAPI** | **`GET /openapi.json`**; **`npm run discovery`** · **`docs/MPPSCAN_DISCOVERY.md`** |
| **OpenClaw + extra capabilities** | Optional plugin: **`openclaw plugins install @anyway-sh/anyway-openclaw`** — then restart gateway if needed; see **`references/openclaw-dancetempo.md`** |
| **Promotion** of a fix for future agents | Short entry under **Successes** or **Failures** in **`CLAWHUB.md`** (no secrets). |

---

## When to activate (triggers)

Use this skill automatically when:

1. The user @-mentions **`llm-full.txt`**, **`CLAWHUB`**, **DanceTempo**, **MPP**, **dance-extras**, or **Tempo testnet/mainnet**.
2. The task touches **`server/index.js`**, **`server/payments.js`**, or **`src/danceExtras*.ts`**.
3. Docs are edited that appear in **`scripts/build-llm-full.mjs`** (bundle sources).
4. The user uploads **ClawHub** / **OpenClaw** / **Copilot** context questions.

---

## Recommended: Cursor / IDE

1. **`@`** `public/llm-full.txt` for broad changes; **`@`** `CLAWHUB.md` when debugging past incidents.
2. Project rules: repo root **`AGENTS.md`** or **`.cursor/rules`** if present — align with **`README.md`**.

See **`references/openclaw-dancetempo.md`** for OpenClaw workspace file hints.

---

## Installation

**From this repository (authoritative):**

```bash
# Skill lives at:
.cursor/skills/clawhub/
```

**Manual copy to OpenClaw skills dir (optional):**

```bash
cp -r .cursor/skills/clawhub ~/.openclaw/skills/dancetempo-clawhub
```

**ClawHub (publish):** Zip **`clawhub/`** (this folder) so the listing includes **`SKILL.md`**, **`references/`**, **`assets/`**, **`hooks/`**, **`scripts/`**. See **`README.md`** in this folder for a file manifest.

### OpenClaw: optional **Anyway** plugin

This skill is **context-only**; **`@anyway-sh/anyway-openclaw`** extends the **OpenClaw** runtime with additional capabilities (separate from DanceTempo). Install when you want both:

```bash
openclaw plugins install @anyway-sh/anyway-openclaw
# If your setup requires it:
openclaw gateway restart
```

Pair with: **this skill** (or [ClawHub listing](https://clawhub.ai/arunnadarasa/dancetempo)) + optional **`dancetempo-clawhub`** hook. Details: **`references/openclaw-dancetempo.md`**.

---

## Repository map (where to look)

```
dancetempo/
├── public/llm-full.txt          # Generated — do not hand-edit; run npm run build:llm
├── CLAWHUB.md                   # Tribal knowledge: successes, failures, checklists
├── README.md                    # Routes, stack, quick start
├── DANCETECH_USE_CASES.md       # Flow-by-flow API contract
├── server/index.js              # Express routes, integrations, MPP proxies
├── server/openapi.mjs           # OpenAPI 3.1 for GET /openapi.json (MPPScan)
├── server/payments.js           # Chain IDs, charge helpers
├── src/hubRoutes.ts             # Hub directory of all /routes
├── src/danceExtrasLiveMpp.ts    # Browser MPP helpers (live flows)
├── src/danceExtrasJudgeWire.ts  # Judge-score wire snippets
├── .github/copilot-instructions.md
└── scripts/build-llm-full.mjs   # Source list for llm-full.txt
```

---

## First load (full orientation)

1. Prefer **`public/llm-full.txt`** (or **`/llm-full.txt`** from a running build) — includes **`CLAWHUB.md`** in the bundle.
2. Regenerate after doc edits: **`npm run build:llm`**.

### Bundle sources

Exact list: **`assets/LLM-BUNDLE-SOURCES.md`** (mirrors `build-llm-full.mjs`).

### EVVM: `llm-full.txt` vs `llms-full.txt`

| Artifact | Role |
| --- | --- |
| **`public/llm-full.txt`** (singular) | DanceTempo-generated; committed; **use first**. |
| **`https://www.evvm.info/llms-full.txt`** (plural) | Upstream EVVM protocol dump — **attach for EVVM-only depth**; do not duplicate into `public/` unless you intend to maintain a fork. |

---

## Debugging (tribal knowledge)

Read **`CLAWHUB.md`** for:

- What succeeded / failed (purl, AgentMail, **`402`** loops, **stale Express on 8787**, etc.)
- Repeatable checks (e.g. **`GET /api/dance-extras/live`**)

Deeper: **`references/troubleshooting.md`**.

---

## Key implementation pointers

| Topic | Location |
| --- | --- |
| Live MPP dance flows | **`POST /api/dance-extras/live/:flowKey/:network`** — **`GET /api/dance-extras/live`** |
| Hub routes | **`src/hubRoutes.ts`** |
| Browser MPP | **`src/danceExtrasLiveMpp.ts`**, **`src/danceExtrasJudgeWire.ts`** |
| Server | **`server/index.js`** |

Concrete snippets: **`references/examples.md`**.

---

## Copilot Chat integration

GitHub Copilot does not load this folder automatically. Options:

1. Commit **`/.github/copilot-instructions.md`** (already in DanceTempo repo).
2. Paste from **`references/copilot-and-agents.md`** into chat or org instructions.

**Quick prompts:**

- “Use **`llm-full.txt`** as context for this PR.”
- “Scan **`CLAWHUB.md`** for 8787 / MPP / purl before changing the server.”
- “After this task, suggest one **CLAWHUB** Success or Failure line (no secrets).”
- “Regenerate **`public/llm-full.txt`** — which files are inputs?” → **`assets/LLM-BUNDLE-SOURCES.md`**

---

## Promotion: CLAWHUB vs llm-full

| Content | Where |
| --- | --- |
| **Stable facts** (routes, env *names*, ports) | **`README.md`**, **`DANCETECH_USE_CASES.md`**, or relevant **`docs/*.md`** — then **`npm run build:llm`**. |
| **Incident / debugging narrative** | **`CLAWHUB.md`** Successes / Failures. |
| **EVVM upstream protocol** | Link **`https://www.evvm.info/llms-full.txt`**; keep **`docs/EVVM_TEMPO.md`** for Tempo-specific steps. |

---

## Verification script

From repo root (optional):

```bash
./.cursor/skills/clawhub/scripts/verify-dancetempo-context.sh
```

Checks that **`public/llm-full.txt`** exists and reminds you of the live MPP **`GET`** check.

---

## OpenClaw hook (optional)

Parity with [self-improving-agent](https://clawhub.ai/pskoett/self-improving-agent): injects a **virtual** `DANCETEMPO_CONTEXT_REMINDER.md` on **`agent:bootstrap`** (skips sub-agents). No network I/O.

```bash
# From this skill folder (or repo: .cursor/skills/clawhub/)
cp -r hooks/openclaw ~/.openclaw/hooks/dancetempo-clawhub

openclaw hooks enable dancetempo-clawhub
```

- **`hooks/openclaw/HOOK.md`** — metadata + enable/disable.
- **`hooks/openclaw/handler.js`** — CommonJS handler (primary).
- **`hooks/openclaw/handler.ts`** — TypeScript handler for OpenClaw (types from **`openclaw/hooks`** at runtime).

Full notes: **`references/openclaw-dancetempo.md`**.

---

## Best practices

1. **Never** paste real **`.env`** secrets into prompts — use **`.env.example`** names only.
2. After editing any file listed in **`build-llm-full.mjs`**, run **`npm run build:llm`** before claiming “docs are updated in the bundle.”
3. Prefer **`GET /api/dance-extras/live`** over guessing whether the server is new.
4. For EVVM, answer **no** to optional Sepolia registry registration until policy allows (see **`docs/EVVM_TEMPO.md`**).

---

## Files in this package

| Path | Purpose |
| --- | --- |
| `SKILL.md` | This file — primary skill entry |
| `README.md` | Package manifest + upload notes for ClawHub |
| `references/copilot-and-agents.md` | Paste blocks for Copilot / chat |
| `references/openclaw-dancetempo.md` | OpenClaw workspace alignment |
| `references/examples.md` | Concrete @-mentions, curls, patterns |
| `references/troubleshooting.md` | Common failures & fixes |
| `assets/LLM-BUNDLE-SOURCES.md` | What feeds `llm-full.txt` |
| `assets/SKILL-TEMPLATE.md` | Template for forking this skill |
| `scripts/verify-dancetempo-context.sh` | Quick repo checks |
| `hooks/openclaw/HOOK.md` | OpenClaw hook manifest |
| `hooks/openclaw/handler.js` | Bootstrap injector (CommonJS) |
| `hooks/openclaw/handler.ts` | Bootstrap injector (TypeScript) |
| `hooks/README.md` | Hook folder index |

---

## See also

- **Published skill:** [clawhub.ai/arunnadarasa/dancetempo](https://clawhub.ai/arunnadarasa/dancetempo)
- **Ecosystem synergy (mpp-nanogpt-modal, nanochat, OpenClaw):** **`docs/ECOSYSTEM_SYNERGY.md`**
- Upstream inspiration: [self-improving-agent](https://clawhub.ai/pskoett/self-improving-agent) (structure: references, assets, scripts, **hooks**).
- DanceTempo repo: **`README.md`**, **`CLAWHUB.md`**.
