# DanceTech Finance Use Cases (Tempo + MPP)

This document defines the full DanceTech use case set for the current prototype, with practical flow steps, API mappings, and testing notes.

## Interaction modes (humans & agents)

**DanceTech Protocol** stays **one** contract: payments and API access are governed by **Tempo** + **MPP/x402**. Colloquial pairings (human↔human, human↔agent, agent↔human, agent↔agent) describe **who authorizes** and **who benefits**, not four different protocol specs.

- **Human ↔ human** — Wallet-funded commerce between people/orgs (battles, passes, royalties). Primary flows in §1–§10 below.
- **Human → agent (orchestrated)** — A human approves spend; an agent or script **calls the same `POST /api/...` routes** (e.g. from MCP, CI, or an assistant). The signing wallet is usually still the user’s unless you implement delegation or server-side treasury.
- **Agent → human** — Backend or paid job **delivers** to a person (email, SMS, pass state). Example: tournament ops bot + AgentMail after a `charge`.
- **Agent → agent** — **Machine-to-machine**: server keys, HMAC, or **x402** between services; overlaps with “machine payments” in MPP. This repo often uses **wallet MPP to this backend**, then **Bearer/API-key** upstream (e.g. AgentMail) to avoid inbox scope issues.

When testing, default to **Tempo testnet** and treat **402** responses as “payment required”—whether the client is a browser or an automated caller that can complete the challenge per your security model.

## Scope

- **MPP catalog:** Hosted integrations (Suno, AgentMail, KicksDB, weather, …) are listed at [mpp.dev/services](https://mpp.dev/services) with base URLs and prices; this repo’s proxies use the same hosts via env (see `README.md` and `.env.example`).
- Network: Tempo `testnet` and `mainnet`
- Payment rail: MPP style `charge` and `session` patterns
- Locus bridge: Laso Finance endpoints can be used for card issuance and status polling
- Status: Battle flow has a dedicated frontend; other use cases are implemented as backend scaffolds and/or demo interactions

## Environment and Networks

- Tempo testnet
  - Chain ID: `42431`
  - Default currency: `pathUSD`
- Tempo mainnet
  - Chain ID: `4217`
  - Default currency: `USDC`

Network can be selected in the dedicated Battle frontend. Backend also accepts per-request `network` for battle endpoints.

---

## 1) Battle Entry + Auto Payout

Intent type: `charge`

### User flow steps

1. Organizer sets battle fee and opens registration.
2. Dancer creates entry intent and receives payment request.
3. Payment is finalized (simulated in scaffold).
4. Organizer finalizes results and executes payout.

### API mapping

- `POST /api/battle/entry`
  - Create intent or verify existing intent
  - Optional body fields: `network`, `intentId`, `simulatePayment`
- `POST /api/battle/result`
- `POST /api/payout/execute`
  - Optional body field: `network`
- `GET /api/payout/:battleId`

### Frontend status

- Fully wired dedicated frontend in `src/App.tsx`.

---

## 2) Judge Score Submission as Paid Write API

Intent type: `charge`

### User flow steps

1. Judge opens scoring console for active round.
2. Judge submits score write.
3. API stores record and returns receipt.
4. Score becomes part of auditable event history.

### API mapping

- `POST /api/judges/score`

---

## 3) Real-Time Cypher Micropot Sponsorship

Intent type: `session` style behavior

### User flow steps

1. Cypher pot opens for active dancer.
2. Fan/support call contributes micro amount.
3. Pot total updates in real time.
4. Pot snapshot can be used for end-of-cypher payout logic.

### API mapping

- `POST /api/cypher/micropot/contribute`

---

## 4) Coaching Minutes Marketplace

Intent type: `session`

### User flow steps

1. Student starts coaching session with selected rate.
2. Usage ticks over time.
3. Session ends, total is computed, receipt returned.
4. Receipt can be fetched for display/audit.

### API mapping

- `POST /api/coaching/start`
- `POST /api/coaching/ping-usage`
- `POST /api/coaching/end`
- `GET /api/coaching/:id/receipt`

---

## 5) Beat API Licensing

Intent type: `charge`

### User flow steps

1. Consumer requests license intent for selected beat.
2. Payment request is created.
3. Access is granted against license id.
4. Stream/download URL is issued with receipt.

### API mapping

- `POST /api/beats/:id/license-intent`
- `POST /api/beats/:id/grant-access`
- `POST /api/music/suno/generate` (Suno integration for AI beat generation)

### Suno relevance

- Suno is relevant to Beat API Licensing because creators can generate new beat drafts, then route into paid licensing flows.
- It supports rapid prototyping for event promos, battle intros, and creator packs tied to monetized beat distribution.
- Tempo x MPP reference endpoint: [suno.mpp.paywithlocus.com](https://suno.mpp.paywithlocus.com)

---

## Parallel (web search / extract / task)

Dedicated UI: **`/parallel`**. Uses **Tempo mainnet** + **`mppx`** for paid `POST`s; task status polling uses **`GET /api/parallel/task/:runId`** (proxied to upstream; typically no per-poll charge).

### API mapping

- `POST /api/parallel/search` → upstream `POST /api/search`
- `POST /api/parallel/extract` → `POST /api/extract`
- `POST /api/parallel/task` → `POST /api/task`
- `GET /api/parallel/task/:runId` → `GET /api/task/:runId`

Reference host: [parallelmpp.dev](https://parallelmpp.dev) · env: **`PARALLEL_BASE_URL`**

---

## OpenAI (chat via MPP gateway)

Dedicated UI: **`/openai`**. Proxies **`POST /v1/chat/completions`** to **`OPENAI_MPP_BASE_URL`** (default `https://openai.mpp.tempo.xyz`) with **Tempo mainnet** + **`mppx`**. Optional **`OPENAI_API_KEY`** adds `Authorization: Bearer` on the server.

The hub **AI explainer** still uses **`POST /api/ai/explain-flow`** and direct **`api.openai.com`** when **`OPENAI_API_KEY`** is set.

### API mapping

- `POST /api/openai/chat/completions` → `POST /v1/chat/completions`
- `POST /api/openai/images/generations` → `POST /v1/images/generations`
- `POST /api/openai/audio/speech` → `POST /v1/audio/speech` (audio returned as base64 JSON)
- `POST /api/openai/audio/transcriptions` → `POST /v1/audio/transcriptions` (multipart `file` + `model`)
- `POST /api/ai/explain-flow` (hub) → OpenAI direct (key required)

Catalog: [mpp.dev/services](https://mpp.dev/services) (OpenAI on Tempo)

---

## Virtual Debit Card Creation (Laso Finance)

Intent type: `charge`

### User flow steps

1. Operator submits funded card request with wallet and amount.
2. Backend routes issuance through Locus/Laso MPP endpoint.
3. API returns card creation response or payment challenge details.
4. Operator polls card status endpoint until card is ready.

### API mapping

- `POST /api/card/create` (Laso-backed create with mock fallback)
- `GET /api/card/:id` (Laso-backed status polling with mock fallback)

### Laso relevance

- Laso Finance bridges USDC agent balances into prepaid card rails for real-world merchant spend.
- This is a practical payment bridge for DanceTech operations and payout-linked spending flows.
- Integration references: [Locus docs](https://docs.paywithlocus.com/), [Locus llms-full](https://docs.paywithlocus.com/llms-full.txt)

---

## 6) Event Footage Clip Rights + Revenue Router

Intent type: `charge`

### User flow steps

1. Buyer selects clip package.
2. Split recipe is prepared (dancer/filmer/organizer).
3. Sale is recorded and mock settlement receipt issued.
4. Sale record is available for reporting and payouts.

### API mapping

- `POST /api/clips/sale`

---

## 7) Krump Reputation Passport

Intent type: `charge`

### User flow steps

1. Issuer selects dancer and badge/claim type.
2. Attestation write is submitted.
3. Receipt confirms write.
4. Profile trust signal can be surfaced in product.

### API mapping

- `POST /api/reputation/attest`

---

## 8) Studio AI Tooling Usage Billing

Intent type: `charge` or metered `session` style

### User flow steps

1. Studio uses an AI tool endpoint.
2. Usage event is submitted with units and mode.
3. Receipt confirms billing event.
4. Usage can be aggregated for billing/reporting.

### API mapping

- `POST /api/studio/ai-usage`

---

## 9) Tournament Ops Bot Actions

Intent type: `charge`

### User flow steps

1. Organizer selects operation action (alerts, bracket updates, etc.).
2. Bot action is submitted.
3. Receipt confirms action write.
4. Ops alert email is sent through AgentMail.
5. Action appears in operations timeline.

### API mapping

- `POST /api/bot/action`
- `POST /api/ops/agentmail/send`
- `POST /api/ops/stablephone/call` (StablePhone AI ops calls)
- `GET /api/ops/stablephone/call/:id` (StablePhone call status/transcript polling, SIWX)
- `POST /api/social/stablesocial/instagram-profile` (StableSocial scrape trigger)
- `GET /api/social/stablesocial/jobs?token=...` (StableSocial job polling, SIWX)
- `POST /api/travel/stable/flights-search` (StableTravel integration for event travel logistics)
- `POST /api/travel/aviationstack/flights` (Aviationstack integration for live flight tracking)
- `POST /api/travel/googlemaps/geocode` (Google Maps geocoding for venue routing and logistics)
- `POST /api/travel/openweather/current` (OpenWeather conditions for event-day operations)

### AgentMail relevance

- AgentMail is relevant to tournament operations for automated human notifications
  (call-time alerts, bracket delay warnings, judge room updates).
- It naturally complements the paid bot action write path by fan-outing operational
  messages to staff inboxes.
- Integration reference: [AgentMail docs](https://docs.agentmail.to/llms-full.txt)

### StablePhone relevance

- StablePhone is relevant for tournament operations because AI voice calls can handle urgent call-time reminders and live coordination tasks.
- It complements bot actions by adding direct phone outreach with transcript/status polling for auditability.
- Paid call initiation is x402/MPP and status polling is SIWX-authenticated wallet access.
- Integration reference: [StablePhone](https://stablephone.dev)

### StableSocial relevance

- StableSocial is relevant for ops and growth because teams can collect social profile intelligence for dancers, events, and fan campaigns.
- It complements tournament operations by enabling lightweight social monitoring workflows with token-based polling.
- Trigger calls are paid (x402/MPP) and `/api/jobs` polling requires SIWX from the same wallet that paid.
- Integration reference: [StableSocial](https://stablesocial.dev)

### StableTravel relevance

- StableTravel is relevant for tournament operations where organizers coordinate travel for dancers, judges, and crew.
- It fits as a paid machine-to-machine API call pattern aligned with Tempo + MPP style rails.
- Integration reference: [StableTravel API](https://stabletravel.dev/llms.txt)

### Aviationstack relevance

- Aviationstack is relevant for tournament operations because ops teams need live flight status and schedule intelligence.
- It complements StableTravel search by enriching logistics with status tracking for arrivals, delays, and gate windows.
- Integration reference: [Aviationstack API docs](https://docs.apilayer.com/aviationstack/docs/api-documentation?utm_source=AviationstackHomePage&utm_medium=Referral)

### Google Maps relevance

- Google Maps is relevant for tournament operations because crews need accurate venue coordinates, route planning, and dispatch precision.
- It complements flight and hotel flows by turning raw addresses into reliable geospatial data for logistics tooling.
- Integration reference: [Google Maps Platform](https://developers.google.com/maps)
- Tempo x MPP reference endpoint: [googlemaps.mpp.tempo.xyz](https://googlemaps.mpp.tempo.xyz)

### OpenWeather relevance

- OpenWeather is relevant to tournament operations because weather conditions impact travel windows, call times, and safety.
- It complements travel routing by adding real-time environmental context for venue and transport decisions.
- Dedicated wallet-paid UI: **`/weather`** → `POST /api/travel/openweather/current` → MPP **`POST /openweather/current-weather`** JSON body `{ lat, lon, units? }` (not legacy GET `/data/2.5/weather`; see [mpp.dev](https://mpp.dev/api/services) OpenWeather).
- Integration reference: [OpenWeather](https://openweathermap.org)
- Tempo x MPP reference endpoint: [weather.mpp.paywithlocus.com](https://weather.mpp.paywithlocus.com)

---

## 10) Fan Membership Battle Pass

Intent type: `charge`

### User flow steps

1. Fan selects membership tier.
2. Purchase request is submitted.
3. Pass record + receipt are returned.
4. Perks can be enabled using pass status.

### API mapping

- `POST /api/fan-pass/purchase`
- `POST /api/market/kicksdb/search` (KicksDB integration for sneaker market intelligence)

### KicksDB relevance

- KicksDB is relevant to fan membership because battle passes can include sneaker/merch perks driven by real market signals.
- It helps ops and growth teams price drops, target inventory, and tailor tier benefits using product and pricing data.
- Integration reference: [KicksDB docs](https://docs.kicks.dev/llms-full.txt)
- Tempo x MPP reference endpoint: [kicksdb.mpp.tempo.xyz](https://kicksdb.mpp.tempo.xyz)

---

## AI Explainer

Purpose: product-facing explanation generation for any flow.

- `POST /api/ai/explain-flow`
  - Uses `OPENAI_API_KEY` on server side only
  - Payload: `flowTitle`, `flowSubtitle`, `steps[]`

---

## Testing Runbook

## Prerequisites

- Install dependencies:
  - `npm install`
- Start app and API:
  - `npm run dev:full`

## Battle dedicated frontend

Open `http://localhost:5173` and run:

1. Select network (`testnet` or `mainnet`).
2. Click `1. Create Entry Intent`.
3. Click `2. Simulate Payment`.
4. Click `3. Finalize Results`.
5. Click `4. Execute Payout`.
6. Optional: `Fetch Payout`.

Observe telemetry:

- status
- selected network and API chain id
- intent id
- payout count
- latest action log

## Endpoint smoke tests (example)

Use `curl` for any endpoint with JSON body and verify:

- HTTP status is 2xx
- response is JSON
- receipt/payload fields are present

---

## Notes and Next Iterations

- Current implementation is scaffold-first and uses in-memory storage.
- Receipts are mock receipts for local flow testing.
- Recommended next step:
  - persist records in a DB,
  - add auth/roles,
  - add webhook signature and retry handling for asynchronous settlement paths.
