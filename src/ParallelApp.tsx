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

const formatApiError = (dataObj: { error?: string; details?: unknown; hint?: string } | null, raw: string) => {
  const err = dataObj?.error
  const d = dataObj?.details
  const detailStr =
    d == null ? '' : typeof d === 'string' ? d : JSON.stringify(d).slice(0, 1200)
  const hint = typeof dataObj?.hint === 'string' ? dataObj.hint : ''
  if (detailStr && err) return hint ? `${err} ${detailStr} (${hint})` : `${err} ${detailStr}`
  if (detailStr) return hint ? `${detailStr} (${hint})` : detailStr
  return err || raw || 'Request failed'
}

type Tab = 'search' | 'extract' | 'task'

export default function ParallelApp() {
  const [tab, setTab] = useState<Tab>('search')
  const [searchQuery, setSearchQuery] = useState('Tempo blockchain machine payments 2026')
  const [searchMode, setSearchMode] = useState<'one-shot' | 'fast'>('one-shot')
  const [extractUrls, setExtractUrls] = useState('https://example.com')
  const [extractObjective, setExtractObjective] = useState('Extract the page title and main headline.')
  const [taskInput, setTaskInput] = useState('Overview of AI agent payment protocols in 2026')
  const [taskProcessor, setTaskProcessor] = useState<'ultra' | 'pro'>('pro')
  const [runId, setRunId] = useState('')
  const [pollRunId, setPollRunId] = useState('')

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'Parallel dashboard initialized. Connect wallet on Tempo mainnet for paid search/extract/task (MPP).',
  ])

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 14))

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
      const e = err as { code?: number }
      if (e?.code === 4902) {
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
      setWalletAddress(selected)
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
      pushLog('Parallel: retry with pull-mode MPP.')
      return await makeMppx('pull').fetch(url, init)
    }
  }

  const runPaidPost = async (path: string, body: unknown) => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first.')
      return
    }
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
      const res = await runMppFetch(path, requestInit)
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) {
        throw new Error(formatApiError(dataObj, raw))
      }
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      setStatus('ok')
      setSummary('Response received')
      pushLog(`Parallel ${path.split('/').pop()} succeeded.`)

      if (tab === 'task' && result && typeof result === 'object' && result !== null) {
        const rid = (result as Record<string, unknown>).run_id ?? (result as Record<string, unknown>).runId
        if (typeof rid === 'string' && rid.trim()) {
          setRunId(rid.trim())
          setPollRunId(rid.trim())
        }
      }
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      setSummary('—')
      pushLog(`Request failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const runSearch = () => runPaidPost('/api/parallel/search', { query: searchQuery.trim(), mode: searchMode })

  const runExtract = () => {
    const urls = extractUrls
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean)
    if (!urls.length) {
      setError('Add at least one URL (one per line).')
      return
    }
    const body: Record<string, unknown> = { urls }
    if (extractObjective.trim()) body.objective = extractObjective.trim()
    runPaidPost('/api/parallel/extract', body)
  }

  const runTask = () =>
    runPaidPost('/api/parallel/task', { input: taskInput.trim(), processor: taskProcessor })

  const pollTask = async () => {
    const id = pollRunId.trim()
    if (!id) {
      setError('Enter a run_id to poll.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/parallel/task/${encodeURIComponent(id)}`)
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) {
        throw new Error(formatApiError(dataObj, raw))
      }
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      setStatus('ok')
      setSummary(`Polled task ${id.slice(0, 12)}…`)
      pushLog('Task poll succeeded (no charge).')
    } catch (err) {
      setStatus('error')
      setError(getErrorMessage(err))
      pushLog(`Poll failed: ${getErrorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Parallel</h1>
        <p>
          Web search, extract, and deep tasks via{' '}
          <a href="https://parallelmpp.dev" target="_blank" rel="noreferrer">
            parallelmpp.dev
          </a>{' '}
          on <strong>Tempo mainnet</strong> (wallet-paid MPP / x402).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet. Paid calls return 402 until MPP payment succeeds.
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

      <section className="card" style={{ marginBottom: '1rem' }}>
        <div className="flow-switch" role="tablist" aria-label="Parallel mode">
          {(
            [
              ['search', 'Search ($0.01)'],
              ['extract', 'Extract ($0.01/url)'],
              ['task', 'Task ($0.10–$0.30)'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? 'active' : 'secondary'}
              onClick={() => setTab(key)}
              disabled={loading}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Request</h2>
          {tab === 'search' ? (
            <div className="field-grid">
              <label style={{ gridColumn: '1 / -1' }}>
                Query
                <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} disabled={loading} />
              </label>
              <label>
                Mode
                <select
                  value={searchMode}
                  onChange={(e) => setSearchMode(e.target.value as 'one-shot' | 'fast')}
                  disabled={loading}
                >
                  <option value="one-shot">one-shot (comprehensive)</option>
                  <option value="fast">fast</option>
                </select>
              </label>
              <div className="actions" style={{ gridColumn: '1 / -1', marginTop: '0.5rem' }}>
                <button onClick={runSearch} disabled={loading || !walletAddress || !searchQuery.trim()}>
                  {loading ? 'Running…' : 'Run search'}
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'extract' ? (
            <div className="field-grid">
              <label style={{ gridColumn: '1 / -1' }}>
                URLs (one per line)
                <textarea
                  rows={5}
                  value={extractUrls}
                  onChange={(e) => setExtractUrls(e.target.value)}
                  disabled={loading}
                  style={{ fontFamily: 'inherit', resize: 'vertical' }}
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Objective (optional)
                <input
                  value={extractObjective}
                  onChange={(e) => setExtractObjective(e.target.value)}
                  disabled={loading}
                />
              </label>
              <div className="actions" style={{ gridColumn: '1 / -1' }}>
                <button onClick={runExtract} disabled={loading || !walletAddress}>
                  {loading ? 'Running…' : 'Run extract'}
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'task' ? (
            <div className="field-grid">
              <label style={{ gridColumn: '1 / -1' }}>
                Input
                <textarea
                  rows={4}
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  disabled={loading}
                  style={{ fontFamily: 'inherit', resize: 'vertical' }}
                />
              </label>
              <label>
                Processor
                <select
                  value={taskProcessor}
                  onChange={(e) => setTaskProcessor(e.target.value as 'ultra' | 'pro')}
                  disabled={loading}
                >
                  <option value="ultra">ultra ($0.30)</option>
                  <option value="pro">pro ($0.10)</option>
                </select>
              </label>
              <div className="actions" style={{ gridColumn: '1 / -1' }}>
                <button onClick={runTask} disabled={loading || !walletAddress || !taskInput.trim()}>
                  {loading ? 'Starting…' : 'Start task'}
                </button>
              </div>
              {runId ? (
                <p className="intent" style={{ gridColumn: '1 / -1', margin: 0 }}>
                  Last <code>run_id</code>: <strong>{runId}</strong>
                </p>
              ) : null}
              <label style={{ gridColumn: '1 / -1' }}>
                Poll run_id (free)
                <input value={pollRunId} onChange={(e) => setPollRunId(e.target.value)} disabled={loading} />
              </label>
              <div className="actions" style={{ gridColumn: '1 / -1' }}>
                <button type="button" className="secondary" onClick={pollTask} disabled={loading}>
                  Poll task status
                </button>
              </div>
            </div>
          ) : null}
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
            {log.map((entry, i) => (
              <li key={`${i}-${entry.slice(0, 40)}`}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      {resultJson ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Result</h3>
          <pre
            style={{
              margin: 0,
              padding: '0.75rem',
              background: '#fafafa',
              borderRadius: '0.5rem',
              border: '1px solid #e4e4e7',
              overflow: 'auto',
              maxHeight: 'min(70vh, 520px)',
              fontSize: '0.8rem',
              lineHeight: 1.45,
            }}
          >
            {resultJson}
          </pre>
        </section>
      ) : null}

      <section className="card api">
        <h3>Parallel API (proxied)</h3>
        <div className="api-list">
          <code>POST /api/parallel/search</code>
          <code>POST /api/parallel/extract</code>
          <code>POST /api/parallel/task</code>
          <code>GET /api/parallel/task/:runId</code>
        </div>
      </section>
    </main>
  )
}
