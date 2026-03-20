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

const shortBlob = (value: string, keep = 84) => {
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
    return 'Wallet submitted the call bundle, but confirmation polling timed out. Check Tempo explorer; if confirmed, recover license by tx hash.'
  }
  if (lower.includes('user rejected') || lower.includes('rejected the request')) {
    return 'Transaction approval was rejected in wallet.'
  }
  if (lower.includes('insufficientbalance') || lower.includes('amount exceeds balance')) {
    return 'Insufficient balance for this payment on selected network.'
  }
  return message
}

export default function BeatsApp() {
  const [beatId, setBeatId] = useState('beat_krump_1')
  const [consumerId, setConsumerId] = useState('consumer_1')
  const [amountDisplay, setAmountDisplay] = useState('12.00')
  const [licenseId, setLicenseId] = useState('')
  const [licenseStatus, setLicenseStatus] = useState<'idle' | 'requires_payment' | 'active'>('idle')
  const [paymentRequest, setPaymentRequest] = useState('')
  const [streamUrl, setStreamUrl] = useState('')
  const [receiptSummary, setReceiptSummary] = useState('')
  const [liveReceipt, setLiveReceipt] = useState('')
  const [paymentMode, setPaymentMode] = useState<'simulate' | 'live'>('simulate')
  const [network, setNetwork] = useState<Network>('testnet')
  const [walletAddress, setWalletAddress] = useState('')
  const [detectedTxHash, setDetectedTxHash] = useState('')
  const [recoveryTxHash, setRecoveryTxHash] = useState('')
  const [txHistory, setTxHistory] = useState(() => listTxHistory())
  const [manualTxHash, setManualTxHash] = useState('')
  const [showFullPaymentRequest, setShowFullPaymentRequest] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([
    'Beat licensing frontend initialized. Create intent then grant access.',
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
    addTxHistory({ hash, network, flow: 'beats' })
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
    () => (network === 'testnet' ? 'https://explore.testnet.tempo.xyz/tx/' : 'https://explore.tempo.xyz/tx/'),
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

  const createLicenseIntent = async () => {
    setLoading(true)
    setError('')
    setDetectedTxHash('')
    try {
      if (paymentMode === 'live') {
        if (!walletAddress) throw new Error('Connect wallet before live licensing.')
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

        const url = `/api/beats/live/${beatId}/license/${network}`
        const requestInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consumerId, amountDisplay }),
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
        if (!res.ok) throw new Error(data?.error || data?.details || text || 'Live license failed')
        setLicenseId(data.licenseId)
        setLicenseStatus(data.status || 'active')
        setPaymentRequest('')
        setStreamUrl(data.streamUrl || '')
        setReceiptSummary(data.receipt?.externalId || data.receipt?.reference || '')
        const receiptHeader = res.headers.get('payment-receipt') || ''
        setLiveReceipt(receiptHeader)
        const receiptTx = extractHexHash(receiptHeader)
        if (receiptTx) {
          setDetectedTxHash(receiptTx)
          setRecoveryTxHash((prev) => prev || receiptTx)
          rememberTx(receiptTx)
        }
        pushLog(`Live license completed (${networkLabel}).`)
      } else {
        const res = await fetch(`/api/beats/${beatId}/license-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consumerId, amountDisplay }),
        })
        const { data, text } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || data?.details || text || 'License intent failed')
        setLicenseId(data.licenseId)
        setLicenseStatus(data.status || 'requires_payment')
        setPaymentRequest(data.paymentRequest || '')
        setStreamUrl('')
        setReceiptSummary('')
        setLiveReceipt('')
        pushLog(`License intent created: ${data.licenseId}`)
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
      pushLog(`Create license intent failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const grantAccess = async () => {
    if (!licenseId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/beats/${beatId}/grant-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseId }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'Grant access failed')
      setLicenseStatus(data.status || 'active')
      setStreamUrl(data.streamUrl || '')
      setReceiptSummary(data.receipt?.externalId || data.receipt?.reference || '')
      pushLog(`Access granted for license ${licenseId}.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`Grant access failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const confirmByTxHash = async () => {
    if (!recoveryTxHash.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/beats/live/${beatId}/confirm-by-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: recoveryTxHash.trim(),
          consumerId,
          amountDisplay,
          network,
        }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || text || 'Confirm by tx failed')
      setLicenseId(data.licenseId)
      setLicenseStatus(data.status || 'active')
      setStreamUrl(data.streamUrl || '')
      setReceiptSummary(data.receipt?.externalId || data.receipt?.reference || '')
      setDetectedTxHash(recoveryTxHash.trim())
      rememberTx(recoveryTxHash.trim())
      setError('')
      pushLog(`Recovered license from tx ${shortValue(recoveryTxHash.trim(), 20)}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Confirm by tx failed: ${message}`)
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
        <h1>Beat API Licensing</h1>
        <p>Dedicated frontend for one-time beat licensing and access unlock.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>License Controls</h2>
          <div className="field-grid">
            <label>
              Beat ID
              <input value={beatId} onChange={(e) => setBeatId(e.target.value)} disabled={loading} />
            </label>
            <label>
              Consumer ID
              <input
                value={consumerId}
                onChange={(e) => setConsumerId(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              License Fee
              <input
                value={amountDisplay}
                onChange={(e) => setAmountDisplay(e.target.value)}
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
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value === 'mainnet' ? 'mainnet' : 'testnet')}
                disabled={loading}
              >
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
            <button onClick={createLicenseIntent} disabled={loading}>
              1. {paymentMode === 'live' ? 'Run Live License Payment' : 'Create License Intent'}
            </button>
            <button onClick={grantAccess} disabled={loading || !licenseId || paymentMode === 'live'}>
              2. Grant Access
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Live Demo Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{licenseStatus}</strong>
            </li>
            <li>
              <span>License ID</span>
              <strong>{licenseId ? shortValue(licenseId, 24) : '—'}</strong>
            </li>
            <li>
              <span>Stream URL</span>
              <strong>
                {streamUrl ? (
                  <a href={streamUrl} target="_blank" rel="noreferrer">
                    {shortValue(streamUrl, 32)}
                  </a>
                ) : (
                  '—'
                )}
              </strong>
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
              onClick={() => copyText(licenseId, 'License ID')}
              disabled={!licenseId}
            >
              Copy License ID
            </button>
            <button
              className="secondary"
              onClick={() => copyText(streamUrl, 'Stream URL')}
              disabled={!streamUrl}
            >
              Copy Stream URL
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
        <h3>License API Contract</h3>
        <div className="api-list">
          <code>POST /api/beats/:id/license-intent</code>
          <code>POST /api/beats/live/:id/license/:network</code>
          <code>POST /api/beats/live/:id/confirm-by-tx</code>
          <code>POST /api/beats/:id/grant-access</code>
        </div>
      </section>

      <section className="card api">
        <h3>Encoded Payment Request</h3>
        <p>Base64url-encoded MPP payment request for beat license purchase.</p>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => setShowFullPaymentRequest((v) => !v)}
            disabled={!paymentRequest}
          >
            {showFullPaymentRequest ? 'Show Short' : 'Show Full'}
          </button>
          <button
            className="secondary"
            onClick={() => copyText(paymentRequest, 'Payment request')}
            disabled={!paymentRequest}
          >
            Copy
          </button>
        </div>
        <pre className="ai-output">
          {paymentRequest
            ? showFullPaymentRequest
              ? paymentRequest
              : shortBlob(paymentRequest)
            : 'No license intent created yet.'}
        </pre>
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
