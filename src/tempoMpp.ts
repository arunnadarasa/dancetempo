import { custom, fallback, http, parseUnits, type Transport } from 'viem'

/** TIP-20 stablecoins on Tempo use 6 decimals (mppx defaults). */
export const TEMPO_TIP20_DECIMALS = 6

/**
 * mppx `tempo.session` auto-management requires `deposit` or `maxDeposit` when the
 * server issues a `tempo.session` x402 challenge (common for OpenAI-on-Tempo and
 * other catalog routes). Without it, the client throws:
 * "No `action` in context and no `deposit` or `maxDeposit` configured."
 *
 * Override via Vite: `VITE_TEMPO_MPP_MAX_DEPOSIT=25` (human-readable token units, default 6 decimals).
 *
 * @see https://mpp.dev/sdk/typescript — Tempo session (auto mode)
 */
export const TEMPO_MPP_SESSION_MAX_DEPOSIT =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TEMPO_MPP_MAX_DEPOSIT?.trim()) || '50'

/** Public RPC for read-only checks (balance) — avoids routing reads through the injected wallet. */
export const TEMPO_MAINNET_RPC_HTTP = 'https://rpc.tempo.xyz'

const base64UrlDecode = (value: string) => {
  const s = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s + pad)
}

/**
 * Parse `suggestedDeposit` (raw integer string) from an x402 `WWW-Authenticate` header
 * (`request="..."` base64url JSON), after the server normalizes the challenge.
 */
export function parseSuggestedDepositRawFromWwwAuthenticate(wwwAuthenticate: string): bigint | null {
  const match = wwwAuthenticate.match(/request="([^"]+)"/)
  if (!match?.[1]) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(base64UrlDecode(match[1]))
  } catch {
    return null
  }
  const raw = (decoded as { request?: { suggestedDeposit?: string } })?.request?.suggestedDeposit
  if (typeof raw !== 'string' || !raw.length) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

/** `maxDeposit` as raw units (matches mppx `parseUnits(maxDeposit, 6)`). */
export function tempoMppMaxDepositRaw(): bigint {
  return parseUnits(TEMPO_MPP_SESSION_MAX_DEPOSIT, TEMPO_TIP20_DECIMALS)
}

/**
 * Deposit size the session opener will use — same rule as `mppx` Session auto mode:
 * `min(suggestedDeposit, maxDeposit)` when both exist, else whichever is set.
 */
export function sessionDepositRequiredRaw(suggestedDepositRaw: bigint | null): bigint {
  const cap = tempoMppMaxDepositRaw()
  if (suggestedDepositRaw !== null) {
    return suggestedDepositRaw < cap ? suggestedDepositRaw : cap
  }
  return cap
}

/** Human-readable USDC-style amount from 6-decimal raw units. */
export function formatTip20Usdc(raw: bigint): string {
  const n = Number(raw) / 10 ** TEMPO_TIP20_DECIMALS
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

const TIP20_INSUFFICIENT_RE = /available:\s*(\d+),\s*required:\s*(\d+)/i

/** Parse on-chain revert text from TIP-20 `InsufficientBalance`. */
export function parseTip20InsufficientBalance(message: string): { available: bigint; required: bigint } | null {
  const m = message.match(TIP20_INSUFFICIENT_RE)
  if (!m) return null
  try {
    return { available: BigInt(m[1]), required: BigInt(m[2]) }
  } catch {
    return null
  }
}

/** Normalize hex/bigint-ish fee fields for EIP-1559 tx objects. */
function toBigIntish(v: unknown): bigint | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'bigint') return v
  if (typeof v === 'string' && v.startsWith('0x')) {
    try {
      return BigInt(v)
    } catch {
      return null
    }
  }
  return null
}

/**
 * MetaMask + some Tempo RPC paths build EIP-1559 txs with `maxPriorityFeePerGas: 0`.
 * A few nodes reject `eth_estimateGas` / send for that shape with a generic
 * "Internal JSON-RPC error". Nudge priority fee to 1 wei when it is zero but
 * `maxFeePerGas` is non-zero.
 */
export function patchTempoEip1559GasFields(tx: Record<string, unknown>): Record<string, unknown> {
  const out = { ...tx }
  const mf = toBigIntish(out.maxFeePerGas)
  const mp = toBigIntish(out.maxPriorityFeePerGas)
  if (mf !== null && mf > 0n && mp !== null && mp === 0n) {
    out.maxPriorityFeePerGas = '0x1'
  }
  return out
}

function patchJsonRpcGasParams(args: { method: string; params?: unknown[] }): { method: string; params?: unknown[] } {
  const { method, params } = args
  if (!params?.length) return args
  if (method === 'eth_estimateGas' || method === 'eth_sendTransaction') {
    const first = params[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return {
        ...args,
        params: [patchTempoEip1559GasFields(first as Record<string, unknown>), ...params.slice(1)],
      }
    }
  }
  return args
}

/**
 * Wrap a viem `Transport` so all JSON-RPC requests pass through gas-param patching.
 * Applies to `fallback([http, custom(ethereum)])` so both public RPC and wallet see
 * the same EIP-1559 shape.
 */
function wrapTransportWithGasPatch(transport: Transport): Transport {
  return (opts) => {
    const t = transport(opts)
    const request = t.request.bind(t)
    return {
      ...t,
      request: async (args) =>
        request(
          patchJsonRpcGasParams(args as { method: string; params?: unknown[] }) as typeof args,
        ),
    }
  }
}

/**
 * Append actionable hints when viem / the wallet reports gas estimation or JSON-RPC failures
 * (common with MetaMask + Tempo, or empty balance).
 */
export function appendMppPaymentHints(message: string): string {
  const tip20 = parseTip20InsufficientBalance(message)
  if (tip20) {
    const { available, required } = tip20
    return (
      `${message}\n\n` +
      `This is a USDC (TIP-20) balance issue, not gas: you have ~${formatTip20Usdc(available)} USDC but the channel deposit needs ~${formatTip20Usdc(required)} USDC. ` +
      `Add USDC on Tempo mainnet, reduce VITE_TEMPO_MPP_MAX_DEPOSIT if the catalog allows a smaller deposit, or set OPENAI_API_KEY on the server to skip wallet payment.`
    )
  }

  const lower = message.toLowerCase()
  const looksGasy =
    lower.includes('estimate gas') ||
    lower.includes('internal json-rpc') ||
    lower.includes('json-rpc error') ||
    (lower.includes('gas') && lower.includes('estimate'))
  if (!looksGasy) return message
  return (
    `${message}\n\n` +
    `Hints: fund USDC on Tempo mainnet for MPP; if MetaMask shows “Internal JSON-RPC” on gas estimate, try Tempo Wallet or another browser wallet; or set OPENAI_API_KEY on the server to skip wallet payment.`
  )
}

/** EIP-1193 provider from `window.ethereum` (typed for viem `custom`). */
export type BrowserEthereumProvider = Parameters<typeof custom>[0]

/**
 * MetaMask often returns `Internal JSON-RPC error` for `eth_estimateGas` on Tempo when the
 * injected provider proxies a flaky RPC. Route public-chain reads/gas simulation through the
 * official Tempo HTTP RPC first, then fall back to the wallet for signing & wallet-specific methods.
 */
export function tempoBrowserWalletTransport(
  ethereum: BrowserEthereumProvider,
  /** Must match the wallet `chain` (mainnet vs testnet). */
  publicRpcHttpUrl: string,
): Transport {
  return wrapTransportWithGasPatch(fallback([http(publicRpcHttpUrl), custom(ethereum)]))
}
