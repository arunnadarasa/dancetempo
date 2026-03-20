import { useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient } from 'viem'
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

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Unknown error'
}

function pickCallIdFromPayload(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const root = data as Record<string, unknown>
  const r = root.result
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    const id = o.call_id ?? o.callId ?? o.id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return ''
}

function pickStatusFromPayload(data: unknown): string {
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

/** StablePhone upstream accepts NANP (US/CA) E.164 only. */
const STABLEPHONE_US_CA_E164 = /^\+1[2-9]\d{9}$/

function validateStablePhoneNumber(phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return 'Enter a phone number.'
  if (!STABLEPHONE_US_CA_E164.test(trimmed)) {
    return 'StablePhone accepts US and Canada numbers only (E.164 +1…, e.g. +14155551234).'
  }
  return null
}

/** Prefer Zod-style `issues[0].message` when the API nests validation errors. */
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

export default function OpsApp() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([
    'Ops dashboard initialized. Connect wallet on Tempo mainnet, then test AgentMail + StablePhone.',
  ])

  const [walletAddress, setWalletAddress] = useState('')

  const [mailTo, setMailTo] = useState('ops@dancetech.finance')
  const [mailInboxId, setMailInboxId] = useState('')
  const [mailSubject, setMailSubject] = useState('Ops Alert Test')
  const [mailText, setMailText] = useState('Call-time reminder: crew call is 6pm sharp.')

  const [phoneNumber, setPhoneNumber] = useState('+14155551234')
  const [callTask, setCallTask] = useState(
    'Call and remind crew call-time is 6pm sharp. Keep it concise and professional.',
  )
  const [voice, setVoice] = useState('natdefault')
  const [callId, setCallId] = useState('')
  const [callStatus, setCallStatus] = useState('—')

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

  /** Official partner flows use Tempo mainnet only; align wallet if x402 names mainnet. */
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
      setWalletAddress(selected)
      await switchWalletToMainnet()
      pushLog(`Wallet connected: ${selected.slice(0, 10)}...`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const makeWalletClient = () =>
    createWalletClient({
      chain: tempoMainnetChain,
      transport: tempoBrowserWalletTransport(
        window.ethereum as BrowserEthereumProvider,
        tempoMainnetChain.rpcUrls.default.http[0],
      ),
      account: walletAddress as `0x${string}`,
    }).extend(tempoActions())

  const makeMppx = (mode: 'push' | 'pull') =>
    MppxClient.create({
      methods: [
        tempoClient({
          account: walletAddress as `0x${string}`,
          mode,
          maxDeposit: TEMPO_MPP_SESSION_MAX_DEPOSIT,
          getClient: async () => makeWalletClient(),
        }),
      ],
      polyfill: false,
    })

  const throwIfJsonError = (res: Response, data: unknown, raw: string, fallback: string) => {
    if (res.ok) return
    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
    const errStr = obj?.error && typeof obj.error === 'string' ? obj.error : null
    const detailStr =
      obj?.details != null
        ? formatErrorDetails(obj.details)
        : obj && 'issues' in obj
          ? formatErrorDetails(obj)
          : ''
    const base = errStr || raw || fallback
    throw new Error(detailStr ? `${base}: ${detailStr}` : base)
  }

  const sendEmail = async () => {
    setLoading(true)
    setError('')
    try {
      if (!walletAddress) throw new Error('Connect wallet before sending AgentMail (Tempo MPP).')

      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inbox_id: mailInboxId.trim(),
          to: mailTo,
          subject: mailSubject,
          text: mailText,
          network: 'mainnet',
        }),
      }

      await switchWalletToMainnet()

      try {
        const pre = await fetch('/api/ops/agentmail/send', requestInit)
        if (pre.status === 402) {
          const www = pre.headers.get('www-authenticate') || ''
          if (www) await ensureWalletMainnetFromChallenge(www)
        }
      } catch {
        // ignore
      }

      const url = '/api/ops/agentmail/send'
      let res: Response
      try {
        res = await makeMppx('push').fetch(url, requestInit)
      } catch (pushErr) {
        const pushMessage = getErrorMessage(pushErr)
        const lower = pushMessage.toLowerCase()
        const userRejected =
          lower.includes('user rejected') ||
          lower.includes('user denied') ||
          lower.includes('denied') ||
          lower.includes('rejected')
        if (userRejected) throw new Error(`Wallet: ${pushMessage}`)
        res = await makeMppx('pull').fetch(url, requestInit)
        pushLog('AgentMail: retry with pull-mode MPP.')
      }

      const { data, raw } = await parseResponse(res)
      throwIfJsonError(res, data, raw, 'AgentMail send failed')
      pushLog(`AgentMail sent to ${mailTo}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`AgentMail failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const startCall = async () => {
    const phoneErr = validateStablePhoneNumber(phoneNumber)
    if (phoneErr) {
      setError(phoneErr)
      pushLog(`StablePhone failed: ${phoneErr}`)
      return
    }

    setLoading(true)
    setError('')
    try {
      if (!walletAddress) throw new Error('Connect wallet before starting a StablePhone call (Tempo MPP).')

      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneNumber, task: callTask, voice }),
      }

      await switchWalletToMainnet()

      try {
        const pre = await fetch('/api/ops/stablephone/call', requestInit)
        if (pre.status === 402) {
          const www = pre.headers.get('www-authenticate') || ''
          if (www) await ensureWalletMainnetFromChallenge(www)
        }
      } catch {
        // ignore
      }

      const url = '/api/ops/stablephone/call'
      let res: Response
      try {
        res = await makeMppx('push').fetch(url, requestInit)
      } catch {
        res = await makeMppx('pull').fetch(url, requestInit)
        pushLog('StablePhone: retry with pull-mode MPP.')
      }

      const { data, raw } = await parseResponse(res)
      throwIfJsonError(res, data, raw, 'StablePhone call failed')

      const id = pickCallIdFromPayload(data)
      setCallId(id)
      setCallStatus(id ? 'started' : 'unknown')
      pushLog(id ? `StablePhone call started (${id.slice(0, 12)}…).` : 'StablePhone call started.')
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`StablePhone failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const checkCall = async () => {
    if (!callId.trim()) return
    if (!walletAddress) {
      setError('Connect wallet to poll StablePhone status (paid endpoint).')
      return
    }

    setLoading(true)
    setError('')
    try {
      const url = `/api/ops/stablephone/call/${encodeURIComponent(callId)}`
      await switchWalletToMainnet()

      try {
        const pre = await fetch(url, { method: 'GET' })
        if (pre.status === 402) {
          const www = pre.headers.get('www-authenticate') || ''
          if (www) await ensureWalletMainnetFromChallenge(www)
        }
      } catch {
        // ignore
      }

      const requestInit: RequestInit = { method: 'GET' }
      let res: Response
      try {
        res = await makeMppx('push').fetch(url, requestInit)
      } catch {
        res = await makeMppx('pull').fetch(url, requestInit)
      }

      const { data, raw } = await parseResponse(res)
      throwIfJsonError(res, data, raw, 'StablePhone status failed')
      const s = pickStatusFromPayload(data)
      setCallStatus(s)
      pushLog(`StablePhone status: ${s}`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Status check failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Ops Comms Dashboard</h1>
        <p>Dedicated testing for AgentMail + StablePhone — Tempo mainnet only (official partners).</p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Payments use <strong>Tempo mainnet</strong>; connect your wallet on that network.
        </p>
        <div className="field-grid" style={{ alignItems: 'end' }}>
          <div className="actions" style={{ margin: 0 }}>
            <button className="secondary" onClick={connectWallet} disabled={loading || !!walletAddress}>
              {walletAddress ? 'Wallet connected' : 'Connect wallet'}
            </button>
          </div>
        </div>
        {walletAddress ? (
          <p className="intent" style={{ marginTop: '0.75rem' }}>
            <strong>{walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</strong>
          </p>
        ) : null}
      </section>

      <section className="grid">
        <article className="card">
          <h2>AgentMail</h2>
          <div className="field-grid">
            <label>
              To
              <input value={mailTo} onChange={(e) => setMailTo(e.target.value)} disabled={loading} />
            </label>
            <label>
              Inbox ID (send from)
              <input
                value={mailInboxId}
                onChange={(e) => setMailInboxId(e.target.value)}
                placeholder="Optional if AGENTMAIL_INBOX_ID is set on server"
                disabled={loading}
              />
            </label>
            <label>
              Subject
              <input value={mailSubject} onChange={(e) => setMailSubject(e.target.value)} disabled={loading} />
            </label>
            <label>
              Text
              <textarea
                value={mailText}
                onChange={(e) => setMailText(e.target.value)}
                disabled={loading}
                rows={3}
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={sendEmail} disabled={loading || !walletAddress}>
              {loading ? 'Sending...' : 'Send AgentMail'}
            </button>
          </div>
        </article>

        <article className="card">
          <h2>StablePhone</h2>
          <div className="field-grid">
            <label>
              Phone number
              <input
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={loading}
                placeholder="+14155551234"
                autoComplete="tel"
              />
            </label>
            <p className="intent" style={{ gridColumn: '1 / -1', margin: 0 }}>
              StablePhone only routes <strong>US &amp; Canada</strong> (+1). Use E.164, e.g.{' '}
              <code>+14155551234</code>.
            </p>
            <label>
              Voice
              <input value={voice} onChange={(e) => setVoice(e.target.value)} disabled={loading} />
            </label>
            <label>
              Task
              <input value={callTask} onChange={(e) => setCallTask(e.target.value)} disabled={loading} />
            </label>
          </div>
          <div className="actions">
            <button onClick={startCall} disabled={loading || !walletAddress}>
              {loading ? 'Working...' : 'Start call'}
            </button>
            <button className="secondary" onClick={checkCall} disabled={loading || !callId || !walletAddress}>
              Check status
            </button>
          </div>
          <ul className="meta">
            <li>
              <span>Call ID</span>
              <strong>{callId || '—'}</strong>
            </li>
            <li>
              <span>Status</span>
              <strong>{callStatus}</strong>
            </li>
          </ul>
        </article>
      </section>

      <section className="grid">
        <article className="card">
          <h3>Latest actions</h3>
          {error ? <p className="error">{error}</p> : null}
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </article>

        <article className="card api">
          <h3>Ops API Contract</h3>
          <div className="api-list">
            <code>POST /api/ops/agentmail/send</code>
            <code>POST /api/ops/stablephone/call</code>
            <code>GET /api/ops/stablephone/call/:id</code>
          </div>
        </article>
      </section>
    </main>
  )
}
