# Ecosystem synergy (DanceTempo & friends)

How **DanceTempo** fits next to other agent, MPP, and research stacks—not duplicate products, **composable layers**.

---

## Technical: MPP + Tempo, different workload

**[gakonst/mpp-nanogpt-modal](https://github.com/gakonst/mpp-nanogpt-modal)** is the clearest **technical** synergy with DanceTempo:

- **Same rails:** [Tempo](https://tempo.xyz), [MPP](https://mpp.dev), **HTTP 402**, `tempo request`, stablecoin settlement — no API-key fiction.
- **Different job:** that repo pays for **Modal GPU** time to run **[nanoGPT](https://github.com/karpathy/nanoGPT)** training; DanceTempo exposes **your** HTTP APIs (DanceTech routes, `402`, receipts).

Together they tell one story: *agents pay on-chain for **compute** (nanoGPT sandbox) and for **APIs** (DanceTempo) with the same wallet behavior.*

---

## Narrative: research stack vs product reference

| Track | Examples | Role |
|-------|----------|------|
| **Research / LLM** | [nanoGPT](https://github.com/karpathy/nanoGPT) → [nanochat](https://github.com/karpathy/nanochat) → [autoresearch](https://github.com/karpathy/autoresearch) | Train models, leaderboards, **agent-in-the-loop** experiments (e.g. `val_bpb`, speedruns). |
| **Product / protocol** | **DanceTempo** | Reference **superapp** + **DanceTech** patterns on **Tempo + MPP/x402** — battle, coaching, dance-extras, integrations, **`/openapi.json`**. |

Same **agent + money + automation** arc, **different layer**: research stacks optimize **model metrics**; DanceTempo optimizes **verifiable payments and ops** for the dance industry (and serves as a **pattern library** for other domains).

---

## OpenClaw: context + automation + plugins

- **[ClawHub skill](https://clawhub.ai/arunnadarasa/dancetempo)** (this repo’s **`.cursor/skills/clawhub/`**) — *what to read* (`llm-full.txt`, `CLAWHUB.md`, smoke tests, MPPScan/OpenAPI).
- **Clawflows-style automation** (multi-step OpenClaw flows) — *how* agents run long jobs across skills.
- **OpenClaw plugins** (e.g. **`@anyway-sh/anyway-openclaw`**) — *extra gateway capabilities* alongside core OpenClaw.

**Synergy:** plugins widen **what the gateway can do**; the DanceTempo skill defines **how to work this repo and its paid HTTP surface** — compose both for multi-step agent work against DanceTempo **and** the wider ecosystem.

---

## See also

- [MPPScan discovery](./MPPSCAN_DISCOVERY.md) — `GET /openapi.json`
- [EVVM on Tempo](./EVVM_TEMPO.md)
- [ClawHub + OpenClaw](../.cursor/skills/clawhub/references/openclaw-dancetempo.md)
