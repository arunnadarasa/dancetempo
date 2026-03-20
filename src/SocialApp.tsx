import { useEffect, useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient, getAddress } from 'viem'
import { tempo as tempoMainnet } from 'viem/chains'
import { tempoActions } from 'viem/tempo'
import './App.css'

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

const tempoMainnetChain = tempoMainnet.extend({
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  feeToken: '0x20c000000000000000000000b9537d11c60e8b50',
  blockTime: 30_000,
})

const toHexChainId = (id: number) => `0x${id.toString(16)}`

const base64UrlDecode = (value: string) => {
  const s = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s + pad)
}

/**
 * Best-effort string for any thrown value (avoids silent "Unknown error" from non-Error rejects).
 */
const getErrorMessage = (err: unknown, maxLen = 2000, depth = 0): string => {
  if (depth > 8) return '(error chain too deep)'
  if (err == null) return err === null ? 'null' : 'undefined'

  if (typeof err === 'string') return err.slice(0, maxLen)
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err)
  }

  if (err instanceof Error) {
    const head = err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message || '(empty Error)'
    let out = head
    if (err.cause !== undefined) {
      out += ` — cause: ${getErrorMessage(err.cause, Math.min(800, maxLen), depth + 1)}`
    }
    if (typeof AggregateError !== 'undefined' && err instanceof AggregateError && err.errors?.length) {
      const bits = err.errors.map((e, i) => `[${i}]: ${getErrorMessage(e, 350, depth + 1)}`)
      out += ` — ${bits.join(' ')}`
    }
    return out.slice(0, maxLen)
  }

  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.message === 'string' && o.message.trim()) return o.message.slice(0, maxLen)
    if (typeof o.reason === 'string' && o.reason.trim()) return o.reason.slice(0, maxLen)
    if (typeof o.err === 'string') return o.err.slice(0, maxLen)
    try {
      const s = JSON.stringify(o)
      if (s && s !== '{}') return s.slice(0, maxLen)
    } catch {
      /* ignore */
    }
  }

  try {
    const s = String(err)
    if (s && s !== '[object Object]') return s.slice(0, maxLen)
  } catch {
    /* ignore */
  }

  return `Unserializable error (type: ${typeof err})`
}

function formatErrorDetails(details: unknown): string {
  if (details == null) return ''
  if (typeof details === 'string') return details
  if (typeof details === 'object' && details !== null && 'issues' in details) {
    const issues = (details as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      const first = issues[0]
      if (first && typeof first === 'object' && first !== null && 'message' in first) {
        const m = (first as { message?: unknown }).message
        if (typeof m === 'string' && m.trim()) return m.trim()
      }
    }
  }
  try {
    return JSON.stringify(details).slice(0, 800)
  } catch {
    return String(details)
  }
}

function pickJobToken(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const root = data as Record<string, unknown>
  const r = root.result
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    const t = o.token ?? o.job_token ?? o.jobToken
    if (typeof t === 'string' && t.trim()) return t.trim()
  }
  const top = root.token
  if (typeof top === 'string' && top.trim()) return top.trim()
  return ''
}

function pickJobStatus(data: unknown): string {
  if (!data || typeof data !== 'object') return 'unknown'
  const root = data as Record<string, unknown>
  const r = root.result
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    const s = o.status ?? o.state
    if (typeof s === 'string' && s.trim()) return s.trim()
  }
  const top = root.status
  if (typeof top === 'string' && top.trim()) return top.trim()
  return 'unknown'
}

/** Parse x402 402 body for `extensions['sign-in-with-x']` (StableSocial jobs). */
function extractSiwxExtension(body: unknown): {
  info: Record<string, unknown>
  supportedChains: Array<{ chainId: string; type: string }>
} | null {
  if (!body || typeof body !== 'object') return null
  const extensions = (body as Record<string, unknown>).extensions
  if (!extensions || typeof extensions !== 'object') return null
  const siwx = (extensions as Record<string, unknown>)['sign-in-with-x']
  if (!siwx || typeof siwx !== 'object') return null
  const sx = siwx as Record<string, unknown>
  const supportedChains = sx.supportedChains
  const info = sx.info
  if (!Array.isArray(supportedChains) || !info || typeof info !== 'object') return null
  return { info: info as Record<string, unknown>, supportedChains }
}

export default function SocialApp() {
  const [username, setUsername] = useState('nike')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'triggered' | 'polling' | 'finished' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'StableSocial dashboard initialized. Connect wallet on Tempo mainnet, then trigger + poll.',
  ])

  // Normalize legacy lowercase addresses (StableSocial SIWX expects EIP-55 checksummed `address`).
  useEffect(() => {
    if (!walletAddress.startsWith('0x')) return
    try {
      const checksummed = getAddress(walletAddress as `0x${string}`)
      if (checksummed !== walletAddress) setWalletAddress(checksummed)
    } catch {
      /* ignore invalid */
    }
  }, [walletAddress])

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))

  const parseResponse = async (res: Response) => {
    const raw = await res.text()
    let data: unknown = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    return { data, raw }
  }

  const throwIfJsonError = (res: Response, data: unknown, raw: string, fallback: string) => {
    if (res.ok) return
    if (typeof data === 'string') {
      throw new Error(`${fallback}: ${data.slice(0, 600)} (HTTP ${res.status})`)
    }
    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
    const errStr =
      typeof obj?.error === 'string'
        ? obj.error
        : obj?.error != null
          ? JSON.stringify(obj.error).slice(0, 400)
          : null
    const msgStr = typeof obj?.message === 'string' ? obj.message : null
    const hintStr = typeof obj?.hint === 'string' ? obj.hint : null
    const detailStr =
      obj?.details != null
        ? formatErrorDetails(obj.details)
        : obj && 'issues' in obj
          ? formatErrorDetails(obj)
          : ''
    const upstream =
      typeof obj?.upstreamStatus === 'number' && typeof obj?.upstreamEndpoint === 'string'
        ? ` [upstream ${obj.upstreamStatus} ${String(obj.upstreamEndpoint).slice(0, 80)}]`
        : typeof obj?.upstreamStatus === 'number'
          ? ` [upstream ${obj.upstreamStatus}]`
          : ''
    const parts = [errStr, msgStr, detailStr, hintStr].filter(Boolean)
    const base =
      parts.length > 0
        ? parts.join(' — ')
        : raw.trim().length > 0
          ? raw.slice(0, 1200)
          : fallback
    throw new Error(`${base}${upstream} (HTTP ${res.status})`)
  }

  const addTempoMainnet = async () => {
    if (!window.ethereum) throw new Error('Wallet not found.')
    const chain = tempoMainnetChain
    const rpcUrl = chain.rpcUrls.default.http[0]
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: toHexChainId(chain.id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [rpcUrl],
          blockExplorerUrls: chain.blockExplorers?.default?.url ? [chain.blockExplorers.default.url] : [],
        },
      ],
    })
  }

  const switchWalletToMainnet = async () => {
    if (!window.ethereum) throw new Error('Wallet not found.')
    const chain = tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    } catch (err: unknown) {
      const anyErr = err as { code?: number } | undefined
      if (anyErr?.code === 4902) {
        await addTempoMainnet()
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
        return
      }
      throw err
    }
  }

  const ensureWalletMainnetFromChallenge = async (wwwAuthenticate: string) => {
    const match = wwwAuthenticate.match(/request="([^"]+)"/)
    if (!match?.[1]) return false
    let decoded: unknown
    try {
      decoded = JSON.parse(base64UrlDecode(match[1]))
    } catch {
      return false
    }
    const chainId = (decoded as { methodDetails?: { chainId?: unknown } })?.methodDetails?.chainId
    if (typeof chainId !== 'number' || chainId !== tempoMainnetChain.id) return false
    await switchWalletToMainnet()
    return true
  }

  const connectWallet = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts?.length) throw new Error('No wallet account returned.')
      const selected = accounts[0]
      // EIP-55 checksummed — StableSocial SIWX compares `address` to the paying wallet string-for-string.
      setWalletAddress(getAddress(selected as `0x${string}`))
      await switchWalletToMainnet()
      pushLog(`Wallet connected: ${selected.slice(0, 10)}…`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const makeWalletClient = () => {
    const account = getAddress(walletAddress as `0x${string}`)
    return createWalletClient({
      chain: tempoMainnetChain,
      transport: tempoBrowserWalletTransport(
        window.ethereum as BrowserEthereumProvider,
        tempoMainnetChain.rpcUrls.default.http[0],
      ),
      account,
    }).extend(tempoActions())
  }

  const makeMppx = (mode: 'push' | 'pull') =>
    MppxClient.create({
      methods: [
        tempoClient({
          account: getAddress(walletAddress as `0x${string}`),
          mode,
          maxDeposit: TEMPO_MPP_SESSION_MAX_DEPOSIT,
          getClient: async () => makeWalletClient(),
        }),
      ],
      polyfill: false,
    })

  const runMppFetch = async (url: string, init: RequestInit) => {
    await switchWalletToMainnet()
    try {
      const pre = await fetch(url, init)
      if (pre.status === 402) {
        const www = pre.headers.get('www-authenticate') || ''
        if (www) await ensureWalletMainnetFromChallenge(www)
      }
    } catch {
      // ignore
    }
    try {
      return await makeMppx('push').fetch(url, init)
    } catch {
      pushLog('StableSocial: retry with pull-mode MPP.')
      return await makeMppx('pull').fetch(url, init)
    }
  }

  /**
   * GET /api/jobs uses SIWX (sign-in-with-x), not Tempo MPP — `accepts` is empty on 402.
   * See https://stablesocial.dev/llms.txt
   */
  const fetchJobsWithSiwx = async (url: string): Promise<Response> => {
    await switchWalletToMainnet()
    let res = await fetch(url, { method: 'GET' })
    if (res.status !== 402) return res
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('StableSocial poll: invalid 402 JSON (expected SIWX challenge)')
    }
    const siwxExt = extractSiwxExtension(json)
    if (!siwxExt) {
      throw new Error('StableSocial poll: missing sign-in-with-x extension on 402')
    }
    const matchingChain = siwxExt.supportedChains.find((c) => c.type === 'eip191')
    if (!matchingChain) {
      throw new Error('StableSocial poll: SIWX challenge has no EVM (eip191) chain')
    }
    const completeInfo = {
      ...siwxExt.info,
      chainId: matchingChain.chainId,
      type: matchingChain.type,
    }
    const { SIGN_IN_WITH_X, createSIWxPayload, encodeSIWxHeader } = await import(
      '@x402/extensions/sign-in-with-x',
    )
    const wc = makeWalletClient()
    const checksummed = getAddress(walletAddress as `0x${string}`)
    const signer = {
      account: { address: checksummed },
      signMessage: async ({ message }: { message: string }) =>
        wc.signMessage({ message, account: checksummed }),
    }
    const payload = await createSIWxPayload(
      completeInfo as Parameters<typeof createSIWxPayload>[0],
      signer,
    )
    const siwxHeader = encodeSIWxHeader(payload)
    res = await fetch(url, {
      method: 'GET',
      headers: { [SIGN_IN_WITH_X]: siwxHeader },
    })
    return res
  }

  const trigger = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first.')
      return
    }
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: username.trim() }),
      }
      const res = await runMppFetch('/api/social/stablesocial/instagram-profile', requestInit)
      const { data, raw } = await parseResponse(res)
      throwIfJsonError(res, data, raw, 'StableSocial trigger failed')
      const t = pickJobToken(data)
      setToken(t)
      setStatus('triggered')
      setSummary(t ? 'Token received. Ready to poll.' : 'Triggered (no token returned).')
      pushLog('Triggered StableSocial scrape.')
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      pushLog(`Trigger failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const pollOnce = async (overrideToken?: string) => {
    const t = (overrideToken ?? token).trim()
    if (!t) return
    if (!walletAddress) {
      setError('Connect wallet to poll (same paid session as trigger).')
      return
    }
    setLoading(true)
    setError('')
    setStatus('polling')
    try {
      const url = `/api/social/stablesocial/jobs?token=${encodeURIComponent(t)}`
      const res = await fetchJobsWithSiwx(url)
      const { data, raw } = await parseResponse(res)
      throwIfJsonError(res, data, raw, 'StableSocial poll failed')
      const s = pickJobStatus(data)
      setSummary(`Job status: ${s}`)
      pushLog(`Polled job status: ${s}`)
      if (s === 'finished') setStatus('finished')
      else setStatus('polling')
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      pushLog(`Poll failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const pollUntilFinished = async () => {
    const t = token.trim()
    if (!t || loading) return
    if (!walletAddress) {
      setError('Connect wallet to poll.')
      return
    }
    setError('')
    setStatus('polling')
    setLoading(true)
    try {
      const attempts = 12
      for (let i = 0; i < attempts; i += 1) {
        const url = `/api/social/stablesocial/jobs?token=${encodeURIComponent(t)}`
        const res = await fetchJobsWithSiwx(url)
        const { data, raw } = await parseResponse(res)
        throwIfJsonError(res, data, raw, 'StableSocial poll failed')
        const s = pickJobStatus(data)
        setSummary(`Job status: ${s}`)
        pushLog(`Poll ${i + 1}/${attempts}: ${s}`)
        if (s === 'finished') {
          setStatus('finished')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      pushLog(`Auto-poll failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Social Ops Dashboard</h1>
        <p>
          <strong>Trigger:</strong> Tempo MPP · <strong>Poll:</strong> SIWX wallet signature (same address that paid).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on <strong>Tempo mainnet</strong> for the paid trigger; polling proves the same address via
          SIWX (you may be prompted to sign a message).
        </p>
        <div className="actions" style={{ margin: 0 }}>
          <button className="secondary" onClick={connectWallet} disabled={loading || !!walletAddress}>
            {walletAddress ? 'Wallet connected' : 'Connect wallet'}
          </button>
        </div>
        {walletAddress ? (
          <p className="intent" style={{ marginTop: '0.75rem' }}>
            <strong>
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
            </strong>
          </p>
        ) : null}
      </section>

      <section className="grid">
        <article className="card">
          <h2>Trigger scrape</h2>
          <div className="field-grid">
            <label>
              Instagram handle
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                placeholder="nike"
                autoComplete="off"
              />
            </label>
            <p className="intent" style={{ gridColumn: '1 / -1', margin: 0 }}>
              StableSocial expects a <code>handle</code> without <code>@</code>.
            </p>
            <label>
              Job token
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={loading}
                placeholder="Filled after trigger"
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={trigger} disabled={loading || !walletAddress}>
              {loading ? 'Working...' : 'Trigger StableSocial'}
            </button>
            <button className="secondary" onClick={() => pollOnce()} disabled={loading || !token.trim() || !walletAddress}>
              Poll once
            </button>
            <button
              className="secondary"
              onClick={pollUntilFinished}
              disabled={loading || !token.trim() || !walletAddress}
            >
              Poll until finished
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{status}</strong>
            </li>
            <li>
              <span>Summary</span>
              <strong>{summary}</strong>
            </li>
          </ul>
          {error ? <p className="error">{error}</p> : null}
          <h4>Latest actions</h4>
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card api">
        <h3>StableSocial API Contract</h3>
        <p className="intent" style={{ marginTop: 0 }}>
          Official flow &amp; error codes:{' '}
          <a href="https://stablesocial.dev/llms.txt" target="_blank" rel="noreferrer">
            stablesocial.dev/llms.txt
          </a>
          . <strong>HTTP 502</strong> on poll = upstream data collection failed (retry or new trigger).
        </p>
        <div className="api-list">
          <code>POST /api/social/stablesocial/instagram-profile</code>
          <code>GET /api/social/stablesocial/jobs?token=...</code>
        </div>
      </section>
    </main>
  )
}
