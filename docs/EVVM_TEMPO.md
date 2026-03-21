# EVVM on Tempo testnet (DanceTempo)

[EVVM](https://www.evvm.info/) is an “Ethereum Virtual Virtual Machine” — deploy a full EVVM **stack** (Evvm, Staking, Estimator, NameService, Treasury, P2PSwap) onto a **host chain**. This repo documents **Tempo testnet only** (chain ID **42431**, Moderato).

## Install (two levels)

### A) Solidity / npm library (lightweight)

In a **Foundry/Hardhat** project (or after `forge install EVVM-org/Testnet-Contracts`):

```bash
npm install @evvm/testnet-contracts
```

DanceTempo does **not** pin this package in `package.json` (transitive deps are large). Use imports such as `import "@evvm/testnet-contracts/interfaces/ICore.sol";` — see [How to make an EVVM service](https://www.evvm.info/docs/HowToMakeAEVVMService).

### B) Full CLI + contracts repo (deploy)

From the DanceTempo repo root:

```bash
npm run evvm:vendor
```

This clones **`vendor/evvm-testnet-contracts`** (gitignored) and runs `./evvm install` (Bun + Foundry setup).

**Prerequisites:** [Foundry](https://getfoundry.sh/), [Bun](https://bun.sh/) (≥ 1.0), `git`.

Manual equivalent:

```bash
git clone --recursive https://github.com/EVVM-org/Testnet-Contracts.git vendor/evvm-testnet-contracts
cd vendor/evvm-testnet-contracts
chmod +x ./evvm
./evvm install
cp .env.example .env
```

## Tempo testnet connection (host chain)

| Field | Value |
|--------|--------|
| Network | Tempo testnet (Moderato) |
| Chain ID | `42431` |
| RPC (HTTP) | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` |

In **`vendor/evvm-testnet-contracts/.env`** set:

```bash
RPC_URL="https://rpc.moderato.tempo.xyz"
# Optional: Tempo contract verification API (see Tempo docs)
# ETHERSCAN_API=...
```

Import a deployer wallet (Foundry keystore — **do not** put private keys in `.env`):

```bash
cast wallet import defaultKey --interactive
```

## Deploy

```bash
cd vendor/evvm-testnet-contracts
./evvm deploy
# or: ./evvm deploy --walletName myWallet
```

Follow the interactive wizard. For **verification**, pick an option that matches Tempo (e.g. **Custom** / **Sourcify** / **Skip** depending on CLI version). Tempo publishes verifier patterns at **[contracts.tempo.xyz](https://contracts.tempo.xyz/docs)** (supported chains include **42431**).

## Registry: skip for now (DanceTempo stance)

After deploy, the CLI may ask to **register** the instance on the **EVVM Registry** (Ethereum Sepolia). That step is **optional**.

- We are **not** relying on an official EVVM ID from the global registry until the founding team can **whitelist / list Tempo** and related metadata.
- At the **“register now?”** prompt, answer **`n`**. You can still use the deployed contracts on **Tempo testnet**; you simply won’t have a public EVVM registry ID yet.
- **Sepolia gas** is only needed if you choose to register later (`./evvm register …`).

## Chain allowlist caveat

Upstream EVVM tooling **validates some testnets** against their registry allowlist. If `./evvm deploy` reports that chain **`42431` is unsupported**, deployment is blocked until **EVVM** adds Tempo testnet to their supported set (track via [EVVM-org/Testnet-Contracts issues](https://github.com/EVVM-org/Testnet-Contracts/issues)). Local chains (e.g. Anvil) skip that check per upstream docs.

## LLM context

Full EVVM documentation bundle: **[https://www.evvm.info/llms-full.txt](https://www.evvm.info/llms-full.txt)**

## In-app

Dedicated page: **`/evvm`** on the DanceTempo hub.
