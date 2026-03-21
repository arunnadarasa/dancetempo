# Testing [Stripe `purl`](https://github.com/stripe/purl) with DanceTempo

This documents a **local smoke test**: `purl` can **parse** the `402 Payment Required` response from DanceTempo’s live MPP routes and identify **MPP on Tempo testnet** (`eip155:42431`).

## Prerequisites

- **DanceTempo API** running on `http://127.0.0.1:8787` (`npm run server` from repo root).
- **`purl` CLI** ≥ 0.2.0 (`cargo install --path cli` from [stripe/purl](https://github.com/stripe/purl), or Homebrew `stripe/purl/purl` when the install completes).
- **`~/.purl/config.toml`** with a **Tempo** wallet (`purl wallet add --type tempo …`). Use a **dedicated test wallet**; do not reuse mainnet keys.

Example (dev-only private key — **never use on mainnet**):

```bash
mkdir -p ~/.purl
purl wallet add --type tempo --name dancetempo-dev \
  -k <YOUR_TESTNET_PRIVATE_KEY_HEX> \
  -p "<keystore-password>" \
  --set-active true
```

## 1) Baseline: `curl` sees `402`

```bash
curl -s -w "\nHTTP:%{http_code}\n" -X POST \
  http://127.0.0.1:8787/api/dance-extras/live/judge-score/testnet \
  -H "Content-Type: application/json" \
  -d '{"network":"testnet","battleId":"b","roundId":"r","judgeId":"j","dancerId":"d","score":9}'
```

Expect **`HTTP:402`** and JSON with `type` / `challengeId` (x402 / paymentauth problem shape).

## 2) `purl --dry-run` (recommended first `purl` test)

`purl` parses the challenge and prints what it **would** pay, without sending a transaction:

```bash
BODY='{"network":"testnet","battleId":"b","roundId":"r","judgeId":"j","dancerId":"d","score":9}'
purl --dry-run -v -X POST --json "$BODY" \
  "http://127.0.0.1:8787/api/dance-extras/live/judge-score/testnet"
```

**Observed (successful parse):**

- `402 status: payment required`
- `Detected protocol: mpp`
- `Network: eip155:42431`
- `Amount: 0.01 pathUSD`
- `Method: tempo`

Exit code may be **non-zero** even on success (`Error: Dry run completed`) — treat output as the source of truth.

## 3) `purl inspect`

`purl inspect <URL>` issues a **GET** by default. DanceTempo’s live route is **POST-only**, so **GET returns `404`**, and `purl` reports “No payment required.” Use **`--dry-run` with `-X POST --json`** for this API instead of `inspect`, unless you add a GET probe route.

## 4) Real payment (optional)

Omit `--dry-run` to attempt an on-chain pay (requires **funded Tempo testnet** balance for the wallet, and valid `MPP_RECIPIENT` / server MPP config):

```bash
purl -X POST --json "$BODY" \
  "http://127.0.0.1:8787/api/dance-extras/live/judge-score/testnet"
```

Use **`--confirm`** if you want an extra prompt.

## Summary

| Tool | Result with DanceTempo live route |
|------|-----------------------------------|
| `curl` | `402` + JSON challenge body |
| `purl --dry-run` + POST JSON | Recognizes **MPP**, **Tempo** (`eip155:42431`), **pathUSD** amount |
| `purl inspect` (GET) | **404** on POST-only route — not applicable without a GET handler |

**Conclusion:** `purl` is **compatible at the payment-requirement layer** with DanceTempo’s MPP/402 responses on Tempo testnet. For automation, prefer **`purl --dry-run`** or a funded **`purl`** wallet on **testnet** before any mainnet use.
