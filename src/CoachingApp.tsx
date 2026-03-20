import { useMemo, useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient } from 'viem'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import { tempoActions } from 'viem/tempo'
import './App.css'
import { addTxHistory, clearTxHistory, explorerTxUrl, listTxHistory } from './txHistory'

type Network = 'testnet' | 'mainnet'
declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

const shortValue = (value: string, keep = 28) => {
  if (!value) return value
  if (value.length <= keep) return value
  return `${value.slice(0, keep)}...`
}

const tempoTestnetChain = tempoModerato.extend({
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  feeToken: '0x20c0000000000000000000000000000000000001',
  // Increase viem sendCallsSync timeout window for slower wallet confirmations.
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

const extractHexHash = (value: string) => {
  const prefixed = value.match(/0x[a-fA-F0-9]{64}/)
  if (prefixed) return prefixed[0]
  const bare = value.match(/\b[a-fA-F0-9]{64}\b/)
  return bare ? `0x${bare[0]}` : ''
}

const mapLivePayError = (message: string) => {
  const lower = message.toLowerCase()
  if (lower.includes('timed out while waiting for call bundle id')) {
    return 'Wallet submitted the call bundle, but confirmation polling timed out. Check Tempo explorer; if the tx is confirmed, session funding likely succeeded.'
  }
  if (lower.includes('user rejected') || lower.includes('rejected the request')) {
    return 'Transaction approval was rejected in wallet.'
  }
  if (lower.includes('insufficientbalance') || lower.includes('amount exceeds balance')) {
    return 'Insufficient balance for this payment on selected network.'
  }
  return message
}

export default function CoachingApp() {
  const [coachId, setCoachId] = useState('coach_krump')
  const [dancerId, setDancerId] = useState('dancer_1')
  const [ratePerMinute, setRatePerMinute] = useState('2.50')
  const [sessionId, setSessionId] = useState('')
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'open' | 'closed'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [amountDisplay, setAmountDisplay] = useState('')
  const [receiptSummary, setReceiptSummary] = useState('')
  const [paymentMode, setPaymentMode] = useState<'simulate' | 'live'>('simulate')
  const [network, setNetwork] = useState<Network>('testnet')
  const [walletAddress, setWalletAddress] = useState('')
  const [liveReceipt, setLiveReceipt] = useState('')
  const [detectedTxHash, setDetectedTxHash] = useState('')
  const [recoveryTxHash, setRecoveryTxHash] = useState('')
  const [txHistory, setTxHistory] = useState(() => listTxHistory())
  const [manualTxHash, setManualTxHash] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([
    'Coaching frontend initialized. Start session and meter usage.',
  ])

  const pushLog = (entry: string) => {
    setLog((prev) => [entry, ...prev].slice(0, 10))
  }

  const parseResponse = async (res: Response) => {
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return { data, text }
  }

  const refreshTxHistory = () => setTxHistory(listTxHistory())
  const rememberTx = (hash: string) => {
    addTxHistory({ hash, network, flow: 'coaching' })
    refreshTxHistory()
  }

  const addManualTx = () => {
    const tx = manualTxHash.trim()
    if (!tx) return
    rememberTx(tx)
    setManualTxHash('')
    pushLog('Manual transaction added to history.')
  }

  const networkLabel = useMemo(() => (network === 'testnet' ? 'Tempo testnet' : 'Tempo mainnet'), [network])
  const txExplorerBase = useMemo(
    () =>
      network === 'testnet'
        ? 'https://explore.testnet.tempo.xyz/tx/'
        : 'https://explore.tempo.xyz/tx/',
    [network],
  )
  const detectedTxUrl = detectedTxHash ? `${txExplorerBase}${detectedTxHash}` : ''

  const addTempoNetwork = async (target: Network) => {
    if (!window.ethereum) return
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
    } catch (err: any) {
      if (err?.code === 4902) {
        await addTempoNetwork(network)
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
        return
      }
      throw err
    }
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
      pushLog(`Wallet connected: ${shortValue(selected, 20)}`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const startSessionLive = async () => {
    if (!walletAddress) throw new Error('Connect wallet before starting live session.')
    await ensureSelectedWalletNetwork()
    const chain = network === 'testnet' ? tempoTestnetChain : tempoMainnetChain
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

    const url = `/api/coaching/live/start/${network}`
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coachId,
        dancerId,
        ratePerMinute: Number.parseFloat(ratePerMinute || '2.5'),
      }),
    } satisfies RequestInit

    let res: Response
    try {
      res = await makeMppx('push').fetch(url, requestInit)
      pushLog('Live pay strategy: push mode.')
    } catch (pushErr) {
      const isMetaMask = Boolean(window.ethereum?.isMetaMask)
      if (isMetaMask) throw pushErr
      res = await makeMppx('pull').fetch(url, requestInit)
      pushLog('Live pay strategy fallback: pull mode.')
    }
    const { data, text } = await parseResponse(res)
    if (!res.ok) throw new Error(data?.error || data?.details || text || 'Live start failed')
    setSessionId(data.sessionId)
    setSessionStatus(data.status || 'open')
    setSeconds(0)
    setAmountDisplay('')
    setReceiptSummary('')
    const receiptHeader = res.headers.get('payment-receipt') || ''
    setLiveReceipt(receiptHeader)
    const receiptTx = extractHexHash(receiptHeader)
    if (receiptTx) {
      setDetectedTxHash(receiptTx)
      setRecoveryTxHash((prev) => prev || receiptTx)
      rememberTx(receiptTx)
    }
    pushLog(`Live session started (${networkLabel}).`)
  }

  const startSession = async () => {
    setLoading(true)
    setError('')
    setDetectedTxHash('')
    try {
      if (paymentMode === 'live') {
        await startSessionLive()
      } else {
        const res = await fetch('/api/coaching/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coachId,
            dancerId,
            ratePerMinute: Number.parseFloat(ratePerMinute || '2.5'),
          }),
        })
        const { data, text } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || data?.details || text || 'Start failed')
        setSessionId(data.sessionId)
        setSessionStatus(data.status || 'open')
        setSeconds(0)
        setAmountDisplay('')
        setReceiptSummary('')
        setLiveReceipt('')
        pushLog(`Session started: ${data.sessionId}`)
      }
    } catch (err) {
      const raw = getErrorMessage(err)
      const detected = extractHexHash(raw)
      if (detected) {
        setDetectedTxHash(detected)
        setRecoveryTxHash(detected)
        rememberTx(detected)
        pushLog(`Detected onchain tx hash: ${detected.slice(0, 12)}...`)
      }
      const message = paymentMode === 'live' ? mapLivePayError(raw) : raw
      setError(message)
      pushLog(`Start session failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const confirmByTxHash = async () => {
    if (!recoveryTxHash.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/coaching/live/confirm-by-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: recoveryTxHash.trim(),
          coachId,
          dancerId,
          ratePerMinute: Number.parseFloat(ratePerMinute || '2.5'),
          network,
        }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'Confirm by tx failed')
      setSessionId(data.sessionId)
      setSessionStatus(data.status || 'open')
      setSeconds(0)
      setAmountDisplay('')
      setReceiptSummary('')
      setDetectedTxHash(recoveryTxHash.trim())
      rememberTx(recoveryTxHash.trim())
      setError('')
      pushLog(`Recovered live session from tx ${shortValue(recoveryTxHash.trim(), 20)}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Confirm by tx failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const pingUsage = async (tickSeconds = 30) => {
    if (!sessionId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/coaching/ping-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, seconds: tickSeconds }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'Usage ping failed')
      setSessionStatus(data.status || 'open')
      setSeconds(Number(data.seconds || 0))
      pushLog(`Usage metered: +${tickSeconds}s`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`Usage ping failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const endSession = async () => {
    if (!sessionId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/coaching/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'End failed')
      setSessionStatus(data.status || 'closed')
      setAmountDisplay(data.amountDisplay || '')
      setReceiptSummary(data.receipt?.externalId || data.receipt?.reference || '')
      pushLog(`Session ended. Amount: $${data.amountDisplay}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`End session failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const fetchReceipt = async () => {
    if (!sessionId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/coaching/${sessionId}/receipt`)
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'Receipt fetch failed')
      setAmountDisplay(data.amountDisplay || amountDisplay)
      setReceiptSummary(data.receipt?.externalId || data.receipt?.reference || '')
      pushLog(`Receipt fetched for session ${sessionId}.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`Fetch receipt failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const copyText = async (value: string, label: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      pushLog(`${label} copied.`)
    } catch {
      pushLog(`Failed to copy ${label.toLowerCase()}.`)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Coaching Minutes Marketplace</h1>
        <p>Dedicated frontend for session-metered coaching billing on Tempo + MPP (simulate/live).</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Session Controls</h2>
          <div className="field-grid">
            <label>
              Coach ID
              <input value={coachId} onChange={(e) => setCoachId(e.target.value)} disabled={loading} />
            </label>
            <label>
              Dancer ID
              <input
                value={dancerId}
                onChange={(e) => setDancerId(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Rate Per Minute
              <input
                value={ratePerMinute}
                onChange={(e) => setRatePerMinute(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Payment Mode
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value === 'live' ? 'live' : 'simulate')}
                disabled={loading}
              >
                <option value="simulate">Simulate</option>
                <option value="live">Live Tempo</option>
              </select>
            </label>
            <label>
              Network
              <select value={network} onChange={(e) => setNetwork(e.target.value === 'mainnet' ? 'mainnet' : 'testnet')} disabled={loading}>
                <option value="testnet">Tempo testnet</option>
                <option value="mainnet">Tempo mainnet</option>
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="secondary" onClick={connectWallet} disabled={loading}>
              {walletAddress ? `Wallet: ${shortValue(walletAddress, 20)}` : 'Connect Wallet'}
            </button>
          </div>
          <div className="actions">
            <input
              placeholder="0x transaction hash"
              value={recoveryTxHash}
              onChange={(e) => setRecoveryTxHash(e.target.value)}
              disabled={loading}
            />
            <button
              className="secondary"
              onClick={confirmByTxHash}
              disabled={loading || paymentMode !== 'live' || !recoveryTxHash.trim()}
            >
              Confirm by Tx Hash
            </button>
          </div>
          <div className="actions">
            <button onClick={startSession} disabled={loading}>
              1. Start Session
            </button>
            <button onClick={() => pingUsage(30)} disabled={loading || !sessionId || sessionStatus !== 'open'}>
              2. Ping Usage (+30s)
            </button>
          </div>
          <div className="actions">
            <button onClick={endSession} disabled={loading || !sessionId || sessionStatus !== 'open'}>
              3. End Session
            </button>
            <button className="secondary" onClick={fetchReceipt} disabled={loading || !sessionId}>
              Fetch Receipt
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Live Demo Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{sessionStatus}</strong>
            </li>
            <li>
              <span>Session ID</span>
              <strong>{sessionId ? shortValue(sessionId, 24) : '—'}</strong>
            </li>
            <li>
              <span>Metered Seconds</span>
              <strong>{seconds}</strong>
            </li>
            <li>
              <span>Final Amount</span>
              <strong>{amountDisplay ? `$${amountDisplay}` : '—'}</strong>
            </li>
            <li>
              <span>Receipt Ref</span>
              <strong>{receiptSummary ? shortValue(receiptSummary, 24) : '—'}</strong>
            </li>
            <li>
              <span>Live Receipt</span>
              <strong>{liveReceipt ? shortValue(liveReceipt, 24) : '—'}</strong>
            </li>
          </ul>
          <div className="actions">
            <button
              className="secondary"
              onClick={() => copyText(sessionId, 'Session ID')}
              disabled={!sessionId}
            >
              Copy Session ID
            </button>
            <button
              className="secondary"
              onClick={() => copyText(receiptSummary, 'Receipt reference')}
              disabled={!receiptSummary}
            >
              Copy Receipt Ref
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
          {detectedTxUrl ? (
            <p>
              Tx detected:{' '}
              <a href={detectedTxUrl} target="_blank" rel="noreferrer">
                {shortValue(detectedTxHash, 24)}
              </a>
            </p>
          ) : null}
          <h4>Latest actions</h4>
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card api">
        <h3>Coaching API Contract</h3>
        <div className="api-list">
          <code>POST /api/coaching/start</code>
          <code>POST /api/coaching/live/start/:network</code>
          <code>POST /api/coaching/live/confirm-by-tx</code>
          <code>POST /api/coaching/ping-usage</code>
          <code>POST /api/coaching/end</code>
          <code>GET /api/coaching/:id/receipt</code>
        </div>
      </section>

      <section className="card api">
        <h3>Transaction History</h3>
        <p>Recent relevant transactions across testnet and mainnet.</p>
        <div className="actions">
          <input
            placeholder="Paste tx hash from explorer"
            value={manualTxHash}
            onChange={(e) => setManualTxHash(e.target.value)}
            disabled={loading}
          />
          <button className="secondary" onClick={addManualTx} disabled={!manualTxHash.trim()}>
            Add Transaction
          </button>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => {
              clearTxHistory()
              refreshTxHistory()
              pushLog('Transaction history cleared.')
            }}
            disabled={txHistory.length === 0}
          >
            Clear History
          </button>
        </div>
        <ul className="log">
          {txHistory.length === 0 ? (
            <li>No saved transactions yet.</li>
          ) : (
            txHistory.map((tx) => (
              <li key={`${tx.network}:${tx.hash}`}>
                <strong>{tx.flow}</strong> - {tx.network} -{' '}
                <a href={explorerTxUrl(tx.network, tx.hash)} target="_blank" rel="noreferrer">
                  {shortValue(tx.hash, 24)}
                </a>
              </li>
            ))
          )}
        </ul>
      </section>
    </main>
  )
}
