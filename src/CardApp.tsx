import { useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient } from 'viem'
import { tempoActions } from 'viem/tempo'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import './App.css'

type Network = 'testnet' | 'mainnet'

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

const tempoTestnetChain = tempoModerato.extend({
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

const shortValue = (value: string, keep = 26) => {
  if (!value) return value
  if (value.length <= keep) return value
  return `${value.slice(0, keep)}...`
}

export default function CardApp() {
  const [walletAddress, setWalletAddress] = useState('')
  const [amountDisplay, setAmountDisplay] = useState('5.00')
  const [currency, setCurrency] = useState('USD')
  const [label, setLabel] = useState('DanceTech virtual debit card')
  const [network, setNetwork] = useState<Network>('testnet')

  const [cardId, setCardId] = useState('')
  const [cardNumber, setCardNumber] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvv, setCvv] = useState('')
  const [status, setStatus] = useState<'idle' | 'ready'>('idle')
  const [receiptRef, setReceiptRef] = useState('')
  const [mppPaymentReceipt, setMppPaymentReceipt] = useState('')
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState('')
  const [demoMessage, setDemoMessage] = useState('')
  const [log, setLog] = useState<string[]>([
    'Virtual card frontend initialized. Laso MPP route enabled for card issuance.',
  ])

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 10))

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

  const createCard = async () => {
    setLoading(true)
    setError('')
    setDemoMessage('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found. Install Tempo Wallet or MetaMask.')
      if (!walletAddress) throw new Error('Connect wallet before issuing card.')
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

      const url = '/api/card/create'
      const requestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, amountDisplay, currency, label, network }),
      } satisfies RequestInit

      let res: Response
      const isMetaMask = Boolean(window.ethereum?.isMetaMask)
      try {
        res = await makeMppx('push').fetch(url, requestInit)
        pushLog('Live pay strategy: push mode.')
      } catch (pushErr) {
        const pushMessage = getErrorMessage(pushErr)
        pushLog(`Push mode failed: ${pushMessage}`)
        if (isMetaMask) throw new Error(`MetaMask push failed: ${pushMessage}`)
        res = await makeMppx('pull').fetch(url, requestInit)
        pushLog('Live pay strategy fallback: pull mode.')
      }

      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        const base = data?.error || data?.message || 'Card creation failed'
        const details = data?.details
        const detailsStr =
          typeof details === 'string' ? details : details !== undefined ? JSON.stringify(details) : ''
        const textStr = typeof text === 'string' && text ? text : ''
        const suffix = [detailsStr, textStr].filter(Boolean).join(': ')
        throw new Error(suffix ? `${base}: ${suffix}` : base)
      }

      const receiptHeader = res.headers.get('payment-receipt') || ''
      setMppPaymentReceipt(receiptHeader)
      setCardId(data.cardId || '')
      setCardNumber(data.cardNumber || '')
      setExpiry(data.expiry || '')
      setCvv(data.cvv || '')
      setStatus(data.status === 'ready' ? 'ready' : 'idle')
      setReceiptRef(data.receipt?.externalId || data.receipt?.reference || '')
      if (data?.demo) {
        setDemoMessage(typeof data.demoReason === 'string' ? data.demoReason : 'Demo mode: using local mock card.')
      } else {
        setDemoMessage('')
      }
      pushLog(`Virtual card created: ${data.cardId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      setDemoMessage('')
      pushLog(`Create virtual card failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const hydrateFromStatus = (data: any) => {
    setCardId(data?.cardId || data?.id || cardId || '')
    setCardNumber(data?.cardNumber || data?.number || cardNumber || '')
    setExpiry(data?.expiry || data?.exp || expiry || '')
    setCvv(data?.cvv || data?.cvc || cvv || '')
    setStatus(data?.status === 'ready' ? 'ready' : 'idle')
    setDemoMessage(data?.demo ? (data?.demoReason || 'Demo mode: Laso card ordering is restricted.') : '')
    setReceiptRef(
      data?.receipt?.externalId ||
        data?.receipt?.reference ||
        data?.receiptRef ||
        receiptRef ||
        '',
    )
  }

  const fetchCardStatus = async () => {
    if (!cardId) return
    setLoading(true)
    setError('')
    try {
      const headers: Record<string, string> = {}
      if (mppPaymentReceipt) headers['payment-receipt'] = mppPaymentReceipt
      const res = await fetch(`/api/card/${encodeURIComponent(cardId)}`, { headers })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        const base = data?.error || data?.message || 'Card status request failed'
        const details = data?.details
        const detailsStr =
          typeof details === 'string' ? details : details !== undefined ? JSON.stringify(details) : ''
        const textStr = typeof text === 'string' && text ? text : ''
        const suffix = [detailsStr, textStr].filter(Boolean).join(': ')
        throw new Error(suffix ? `${base}: ${suffix}` : base)
      }
      hydrateFromStatus(data)
      pushLog(`Card status checked: ${data?.status || 'unknown'}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`Card status failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const pollUntilReady = async () => {
    if (!cardId || polling) return
    setPolling(true)
    setError('')
    try {
      const attempts = 10
      for (let i = 0; i < attempts; i += 1) {
        const headers: Record<string, string> = {}
        if (mppPaymentReceipt) headers['payment-receipt'] = mppPaymentReceipt
        const res = await fetch(`/api/card/${encodeURIComponent(cardId)}`, { headers })
        const { data, text } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || data?.details || text || 'Card status request failed')
        hydrateFromStatus(data)
        const nextStatus = data?.status || 'unknown'
        pushLog(`Poll ${i + 1}/${attempts}: ${nextStatus}`)
        if (nextStatus === 'ready') {
          pushLog('Card reached ready status.')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      pushLog(`Auto-poll failed: ${message}`)
    } finally {
      setPolling(false)
    }
  }

  const copyText = async (value: string, labelText: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      pushLog(`${labelText} copied.`)
    } catch {
      pushLog(`Failed to copy ${labelText.toLowerCase()}.`)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Virtual Debit Card</h1>
        <p>Issue a funded virtual debit card via Laso Finance on Tempo + MPP rails.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Card Creation</h2>
          <div className="field-grid">
            <label>
              Wallet Address
              <input
                placeholder="0x..."
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                disabled={loading}
              />
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
            <label>
              Fund Amount
              <input
                value={amountDisplay}
                onChange={(e) => setAmountDisplay(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Currency
              <input value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={loading} />
            </label>
            <label>
              Label
              <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={loading} />
            </label>
          </div>
          <div className="actions">
            <button className="secondary" onClick={connectWallet} disabled={loading || polling}>
              {walletAddress ? `Wallet: ${shortValue(walletAddress, 20)}` : 'Connect Wallet'}
            </button>
            <button onClick={createCard} disabled={loading || polling}>
              {loading ? 'Issuing Card...' : 'Create Virtual Card'}
            </button>
            <button className="secondary" onClick={fetchCardStatus} disabled={!cardId || loading || polling}>
              Check Card Status
            </button>
            <button className="secondary" onClick={pollUntilReady} disabled={!cardId || loading || polling}>
              {polling ? 'Polling...' : 'Poll Until Ready'}
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
              <span>Card ID</span>
              <strong>{cardId ? shortValue(cardId) : '—'}</strong>
            </li>
            <li>
              <span>Card Number</span>
              <strong>{cardNumber || '—'}</strong>
            </li>
            <li>
              <span>Expiry</span>
              <strong>{expiry || '—'}</strong>
            </li>
            <li>
              <span>CVV</span>
              <strong>{cvv || '—'}</strong>
            </li>
            <li>
              <span>Receipt Ref</span>
              <strong>{receiptRef ? shortValue(receiptRef) : '—'}</strong>
            </li>
          </ul>
          <div className="actions">
            <button className="secondary" onClick={() => copyText(cardId, 'Card ID')} disabled={!cardId}>
              Copy Card ID
            </button>
            <button
              className="secondary"
              onClick={() => copyText(cardNumber, 'Card number')}
              disabled={!cardNumber}
            >
              Copy Card Number
            </button>
            <button className="secondary" onClick={() => copyText(receiptRef, 'Receipt reference')} disabled={!receiptRef}>
              Copy Receipt Ref
            </button>
          </div>
          {demoMessage ? <p className="demo">{demoMessage}</p> : null}
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
        <h3>Card API Contract</h3>
        <div className="api-list">
          <code>POST /api/card/create</code>
          <code>GET /api/card/:id</code>
        </div>
      </section>
    </main>
  )
}
