import { useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient } from 'viem'
import { tempoActions } from 'viem/tempo'
import { tempo as tempoMainnet, tempoModerato as tempoTestnet } from 'viem/chains'
import './App.css'
import { addTxHistory, clearTxHistory, explorerTxUrl, listTxHistory } from './txHistory'

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

export default function EmailApp() {
  const [to, setTo] = useState('ops@dancetech.finance')
  const [inboxId, setInboxId] = useState('') // AgentMail inbox to send FROM (required by AgentMail REST API)
  const [subject, setSubject] = useState('DanceTech Ops Alert Test')
  const [text, setText] = useState(
    'This is a dedicated AgentMail integration test from the DanceTech email dashboard.',
  )
  const [html, setHtml] = useState(
    '<p><strong>DanceTech Ops Alert</strong></p><p>Dedicated AgentMail integration test.</p>',
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle')
  const [provider, setProvider] = useState('')
  const [resultPreview, setResultPreview] = useState('—')
  const [log, setLog] = useState<string[]>([
    'Email dashboard initialized. Configure a payload and send through AgentMail.',
  ])
  const [txHistory, setTxHistory] = useState(() => listTxHistory())
  const [manualTxHash, setManualTxHash] = useState('')

  type Network = 'testnet' | 'mainnet'
  type PaymentMode = 'simulate' | 'live'

  const [walletAddress, setWalletAddress] = useState('')
  const [network, setNetwork] = useState<Network>('mainnet')
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('live')

  const [tempoTestnetEnabledForAgentMail, setTempoTestnetEnabledForAgentMail] = useState<boolean>(() => {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('agentmail_tempo_testnet_supported') : null
    return raw === 'true'
  })

  const tempoTestnetChain = tempoTestnet.extend({
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    feeToken: '0x20c0000000000000000000000000000000000001',
    blockTime: 30_000,
  })

  const tempoMainnetChain = tempoMainnet.extend({
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    feeToken: '0x20c000000000000000000000b9537d11c60e8b50',
    blockTime: 30_000,
  })

  const toHexChainId = (id: number) => `0x${id.toString(16)}`

  const getErrorMessage = (err: unknown) => {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    return 'Unknown error'
  }

  const addTempoNetwork = async (target: Network) => {
    if (!window.ethereum) throw new Error('Wallet not found. Install Tempo Wallet or MetaMask.')
    const chain = target === 'testnet' ? tempoTestnetChain : tempoMainnetChain
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

  const ensureSelectedWalletNetwork = async () => {
    if (!window.ethereum) throw new Error('Wallet not found. Install Tempo Wallet or MetaMask.')
    const chain = network === 'testnet' ? tempoTestnetChain : tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    } catch (err: unknown) {
      const anyErr = err as { code?: number } | undefined
      if (anyErr?.code === 4902) {
        await addTempoNetwork(network)
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
        return
      }
      throw err
    }
  }

  const base64UrlDecode = (value: string) => {
    const s = value.replace(/-/g, '+').replace(/_/g, '/')
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
    return atob(s + pad)
  }

  const ensureWalletTempoChainFromChallenge = async (wwwAuthenticate: string) => {
    const match = wwwAuthenticate.match(/request="([^"]+)"/)
    if (!match?.[1]) return null

    let decoded: unknown
    try {
      decoded = JSON.parse(base64UrlDecode(match[1]))
    } catch {
      return null
    }

    type ChallengeDecoded = { methodDetails?: { chainId?: unknown } }
    const chainId = (decoded as ChallengeDecoded | null | undefined)?.methodDetails?.chainId
    if (typeof chainId !== 'number') return null

    const target: Network = chainId === tempoTestnetChain.id ? 'testnet' : 'mainnet'
    if (target === 'testnet' && !tempoTestnetEnabledForAgentMail) {
      throw new Error('Tempo testnet is not supported for AgentMail in this environment. Use Tempo mainnet.')
    }

    setNetwork(target)
    const chain = target === 'testnet' ? tempoTestnetChain : tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)

    try {
      await window.ethereum?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    } catch (err: unknown) {
      const anyErr = err as { code?: number } | undefined
      if (anyErr?.code === 4902) {
        await addTempoNetwork(target)
        await window.ethereum?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
      } else {
        throw err
      }
    }

    return target
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
      await ensureSelectedWalletNetwork()
      pushLog(`Wallet connected: ${selected.slice(0, 10)}...`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))

  const extractHexHash = (value: string) => {
    const prefixed = value.match(/0x[a-fA-F0-9]{64}/)
    if (prefixed) return prefixed[0]
    const bare = value.match(/\b[a-fA-F0-9]{64}\b/)
    return bare ? `0x${bare[0]}` : ''
  }

  const trackEmailTxHash = (hash: string, targetNetwork: Network) => {
    const trimmed = hash.trim()
    if (!trimmed) return
    addTxHistory({ hash: trimmed, network: targetNetwork, flow: 'email' })
    setTxHistory(listTxHistory())
  }

  const refreshTxHistory = () => setTxHistory(listTxHistory())

  const addManualTx = () => {
    const hash = extractHexHash(manualTxHash.trim())
    if (!hash) {
      setError('Invalid tx hash. Expected 0x + 64 hex characters.')
      return
    }
    trackEmailTxHash(hash, network)
    setManualTxHash('')
    pushLog(`Email tx added manually: ${hash.slice(0, 10)}...`)
  }

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

  const sendEmail = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inbox_id: inboxId.trim(), to, subject, text, html, network }),
      }

      let res: Response
      let resolvedNetwork: Network = network

      if (paymentMode === 'live') {
        if (!walletAddress) throw new Error('Connect wallet before sending AgentMail (Live / Tempo MPP).')
        await ensureSelectedWalletNetwork()

        // Preflight: if the x402 challenge expects a specific chainId,
        // switch MetaMask before we try `send`.
        try {
          const pre = await fetch('/api/ops/agentmail/send', requestInit)
          if (pre.status === 402) {
            const www = pre.headers.get('www-authenticate') || ''
            const target = www ? await ensureWalletTempoChainFromChallenge(www) : null
            if (target) resolvedNetwork = target
          }
        } catch {
          // Ignore preflight failures; we'll fall back to the user-selected network.
        }

        const chain = resolvedNetwork === 'testnet' ? tempoTestnetChain : tempoMainnetChain
        const walletClient = createWalletClient({
          chain,
          transport: tempoBrowserWalletTransport(
            window.ethereum as BrowserEthereumProvider,
            chain.rpcUrls.default.http[0],
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
                getClient: async () => walletClient,
              }),
            ],
            polyfill: false,
          })

        const url = '/api/ops/agentmail/send'

        try {
          res = await makeMppx('push').fetch(url, requestInit)
          pushLog('Live pay strategy: push mode.')
        } catch (pushErr) {
          const pushMessage = getErrorMessage(pushErr)
          pushLog(`Push mode failed: ${pushMessage}`)
          const lower = pushMessage.toLowerCase()
          const userRejected =
            lower.includes('user rejected') ||
            lower.includes('user denied') ||
            lower.includes('denied') ||
            lower.includes('rejected')
          if (userRejected) throw new Error(`MetaMask push failed: ${pushMessage}`)

          // Retry with pull-mode when push fails (gas estimation/receipt flakiness).
          res = await makeMppx('pull').fetch(url, requestInit)
          pushLog('Live pay strategy fallback: pull mode.')
        }
      } else {
        // Simulate: call backend without wallet-paid MPP flow.
        res = await fetch('/api/ops/agentmail/send', requestInit)
      }

      const { data, raw } = await parseResponse(res)
      const headerReceipt = res.headers.get('payment-receipt') || res.headers.get('Payment-Receipt') || ''
      const txFromHeader = extractHexHash(headerReceipt)
      if (txFromHeader) trackEmailTxHash(txFromHeader, resolvedNetwork)
      if (!res.ok) {
        const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
        const errStr = obj?.error && typeof obj.error === 'string' ? obj.error : null
        const details =
          obj?.details && typeof obj.details === 'string'
            ? obj.details
            : obj?.details
              ? JSON.stringify(obj.details).slice(0, 500)
              : null
        const base = errStr || raw || 'AgentMail send failed'
        throw new Error(details ? `${base}: ${details}` : base)
      }
      setStatus('sent')
      const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
      const provider = obj?.provider && typeof obj.provider === 'string' ? obj.provider : 'agentmail'
      setProvider(provider)
      const preview =
        obj && typeof obj.result === 'string'
          ? obj.result
          : obj && obj.result
            ? JSON.stringify(obj.result).slice(0, 220)
            : 'Email accepted by provider.'
      setResultPreview(preview)

      const txFromPreview = extractHexHash(preview)
      if (txFromPreview) trackEmailTxHash(txFromPreview, resolvedNetwork)

      pushLog(`Email sent to ${to}.`)

      if (paymentMode === 'live' && resolvedNetwork === 'testnet') {
        // Remember success so next time we can allow testnet in this browser.
        window.localStorage.setItem('agentmail_tempo_testnet_supported', 'true')
        setTempoTestnetEnabledForAgentMail(true)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus('error')
      setError(message)
      pushLog(`Send failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const createInbox = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      if (paymentMode !== 'live') throw new Error('Inbox creation is only supported in Live mode (Tempo MPP).')
      if (!walletAddress) throw new Error('Connect wallet before creating an AgentMail inbox (Live / Tempo MPP).')

      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Let AgentMail auto-provision an inbox with a stable domain.
          username: `mpp-${Date.now()}`,
          domain: 'agentmail.to',
          display_name: 'Tempo AgentMail Inbox',
        }),
      }

      let res: Response
      let resolvedNetwork: Network = network

      await ensureSelectedWalletNetwork()

      // Preflight: if the 402 challenge requests a specific Tempo chainId,
      // switch MetaMask before attempting to solve + create.
      try {
        const pre = await fetch('/api/ops/agentmail/inbox/create', requestInit)
        if (pre.status === 402) {
          const www = pre.headers.get('www-authenticate') || ''
          const target = www ? await ensureWalletTempoChainFromChallenge(www) : null
          if (target) resolvedNetwork = target
        }
      } catch {
        // Ignore preflight failures; we'll fall back to the user-selected network.
      }

      const chain = resolvedNetwork === 'testnet' ? tempoTestnetChain : tempoMainnetChain
      const walletClient = createWalletClient({
        chain,
        transport: tempoBrowserWalletTransport(
          window.ethereum as BrowserEthereumProvider,
          chain.rpcUrls.default.http[0],
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
              getClient: async () => walletClient,
            }),
          ],
          polyfill: false,
        })

      const url = '/api/ops/agentmail/inbox/create'

      // For inbox creation, MetaMask has shown better reliability with pull-first.
      try {
        res = await makeMppx('pull').fetch(url, requestInit)
        pushLog('Live pay strategy: pull mode.')
      } catch (pullErr) {
        const pullMessage = getErrorMessage(pullErr)
        pushLog(`Pull mode failed: ${pullMessage}`)
        const lower = pullMessage.toLowerCase()
        const userRejected =
          lower.includes('user rejected') ||
          lower.includes('user denied') ||
          lower.includes('denied') ||
          lower.includes('rejected')
        if (userRejected) throw new Error(`MetaMask pull failed: ${pullMessage}`)

        res = await makeMppx('push').fetch(url, requestInit)
        pushLog('Live pay strategy fallback: push mode.')
      }

      const { data, raw } = await parseResponse(res)
      if (!res.ok) {
        const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
        const errStr = obj?.error && typeof obj.error === 'string' ? obj.error : null
        const details =
          obj?.details && typeof obj.details === 'string'
            ? obj.details
            : obj?.details
              ? JSON.stringify(obj.details).slice(0, 500)
              : null
        throw new Error(errStr || details || raw || 'AgentMail inbox create failed')
      }

      const topObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
      const resultObj =
        topObj && typeof topObj.result === 'object' && topObj.result !== null ? (topObj.result as Record<string, unknown>) : null
      const createdInboxId =
        (resultObj && typeof resultObj.inbox_id === 'string' ? (resultObj.inbox_id as string) : null) ||
        (resultObj && typeof resultObj.email === 'string' ? (resultObj.email as string) : null)

      if (!createdInboxId) throw new Error('Inbox created but could not read `inbox_id` from response.')
      setInboxId(createdInboxId)
      setStatus('sent')
      pushLog(`AgentMail inbox created: ${createdInboxId}`)

      if (resolvedNetwork === 'testnet') {
        window.localStorage.setItem('agentmail_tempo_testnet_supported', 'true')
        setTempoTestnetEnabledForAgentMail(true)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus('error')
      setError(message)
      pushLog(`Create inbox failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Email Ops Dashboard</h1>
        <p>Dedicated AgentMail frontend for tournament operations alerts and notification testing.</p>
        <p>
          Live mode uses a wallet-paid relay: your wallet pays via Tempo MPP, then backend sends through
          AgentMail API for the configured inbox.
        </p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Compose AgentMail Request</h2>
          <div className="field-grid">
            <label>
              To
              <input value={to} onChange={(e) => setTo(e.target.value)} disabled={loading} />
            </label>
            <label>
              Inbox ID (send from)
              <input
                value={inboxId}
                onChange={(e) => setInboxId(e.target.value)}
                placeholder="e.g. ops@agentmail.to"
                disabled={loading}
              />
            </label>
            <label>
              Subject
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={loading} />
            </label>
            <label>
              Text Body
              <input value={text} onChange={(e) => setText(e.target.value)} disabled={loading} />
            </label>
            <label>
              HTML Body
              <input value={html} onChange={(e) => setHtml(e.target.value)} disabled={loading} />
            </label>
            <label>
              Payment Mode
              <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PaymentMode)} disabled={loading}>
                <option value="live">Live (Tempo MPP)</option>
                <option value="simulate">Simulate</option>
              </select>
            </label>
            <label>
              Network
              <select value={network} onChange={(e) => setNetwork(e.target.value as Network)} disabled={loading || paymentMode !== 'live'}>
                <option value="mainnet">Tempo mainnet</option>
                {tempoTestnetEnabledForAgentMail ? <option value="testnet">Tempo testnet</option> : null}
              </select>
            </label>
          </div>
          <div className="actions">
            {paymentMode === 'live' ? (
              <button className="secondary" onClick={connectWallet} disabled={loading}>
                {walletAddress ? `Wallet: ${walletAddress.slice(0, 10)}...` : 'Connect Wallet'}
              </button>
            ) : null}
            {paymentMode === 'live' ? (
              <button className="secondary" onClick={createInbox} disabled={loading || !walletAddress}>
                {loading ? 'Working...' : 'Create Inbox (Live)'}
              </button>
            ) : null}
            <button
              onClick={sendEmail}
              disabled={loading || (paymentMode === 'live' && (!walletAddress || !inboxId.trim()))}
            >
              {loading ? 'Sending...' : paymentMode === 'live' ? 'Send AgentMail Email (Live)' : 'Send AgentMail Email (Simulate)'}
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Live Demo Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{status}</strong>
            </li>
            <li>
              <span>Provider</span>
              <strong>{provider || '—'}</strong>
            </li>
            <li>
              <span>Result Preview</span>
              <strong>{resultPreview}</strong>
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
        <h3>Email API Contract</h3>
        <div className="api-list">
          <code>POST /api/ops/agentmail/send</code>
          <code>POST /api/ops/agentmail/inbox/create</code>
        </div>
      </section>

      <section className="card api">
        <h3>Email Transaction History</h3>
        <p>Tempo transactions captured for wallet-paid email sends.</p>
        <div className="actions">
          <input
            placeholder="Paste tx hash from explorer"
            value={manualTxHash}
            onChange={(e) => setManualTxHash(e.target.value)}
          />
          <button className="secondary" onClick={addManualTx} disabled={!manualTxHash.trim()}>
            Add Transaction
          </button>
          <button className="secondary" onClick={refreshTxHistory}>
            Refresh
          </button>
          <button
            className="secondary"
            onClick={() => {
              clearTxHistory()
              refreshTxHistory()
            }}
            disabled={txHistory.length === 0}
          >
            Clear History
          </button>
        </div>
        <ul className="log">
          {txHistory.filter((item) => item.flow === 'email').length === 0 ? (
            <li>No email transactions tracked yet.</li>
          ) : (
            txHistory
              .filter((item) => item.flow === 'email')
              .map((item) => (
                <li key={`${item.hash}_${item.createdAt}`}>
                  {item.network} -{' '}
                  <a href={explorerTxUrl(item.network, item.hash)} target="_blank" rel="noreferrer">
                    {item.hash.slice(0, 12)}...{item.hash.slice(-8)}
                  </a>
                </li>
              ))
          )}
        </ul>
      </section>
    </main>
  )
}
