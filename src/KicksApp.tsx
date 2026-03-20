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

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

export default function KicksApp() {
  type Network = 'testnet' | 'mainnet'
  type PaymentMode = 'simulate' | 'live'

  const [query, setQuery] = useState('Nike Dunk')
  const [market, setMarket] = useState('US')
  const [perPage, setPerPage] = useState('5')
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [walletAddress, setWalletAddress] = useState('')
  const [network, setNetwork] = useState<Network>('mainnet')
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('live')
  const [tempoTestnetEnabledForKicks, setTempoTestnetEnabledForKicks] = useState<boolean>(() => {
    // "Remove testnet unless supported": only enable auto-switch to Tempo testnet for KicksDB
    // after a successful run on this browser.
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem('kicksdb_tempo_testnet_supported') : null
    return raw === 'true'
  })

  const [log, setLog] = useState<string[]>([
    'KicksDB dashboard initialized. Run product search queries for market intel.',
  ])

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

  const getErrorMessage = (err: unknown) => {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    return 'Unknown error'
  }

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))

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

  const base64UrlDecode = (value: string) => {
    // base64url -> base64
    const s = value.replace(/-/g, '+').replace(/_/g, '/')
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
    return atob(s + pad)
  }

  const ensureWalletTempoChainFromChallenge = async (wwwAuthenticate: string) => {
    const match = wwwAuthenticate.match(/request="([^"]+)"/)
    if (!match?.[1]) return null

    const requestB64 = match[1]
    let decoded: any
    try {
      decoded = JSON.parse(base64UrlDecode(requestB64))
    } catch {
      return null
    }

    const chainId = decoded?.methodDetails?.chainId
    if (typeof chainId !== 'number') return null

    const target: Network = chainId === tempoTestnetChain.id ? 'testnet' : 'mainnet'
    if (target === 'testnet' && !tempoTestnetEnabledForKicks) {
      throw new Error('Tempo testnet is not supported for KicksDB in this environment. Use Tempo mainnet.')
    }
    setNetwork(target)

    const chain = target === 'testnet' ? tempoTestnetChain : tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)
    try {
      await window.ethereum?.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    } catch (err: any) {
      if (err?.code === 4902) {
        await addTempoNetwork(target)
        await window.ethereum?.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        })
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
  const parseResponse = async (res: Response) => {
    const raw = await res.text()
    let data: any = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    return { data, raw }
  }

  const runSearch = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          market,
          per_page: Number(perPage),
        }),
      }

      let res: Response
      let resolvedNetwork: Network = network

      if (paymentMode === 'live') {
        if (!walletAddress) throw new Error('Connect wallet before running a live KicksDB search.')
        await ensureSelectedWalletNetwork()

        // Preflight: parse the x402 challenge to learn which Tempo chain the
        // KicksDB endpoint expects, then switch MetaMask accordingly.
        // Without this, MetaMask estimateGas frequently fails.
        try {
          const pre = await fetch('/api/market/kicksdb/search', requestInit)
          if (pre.status === 402) {
            const www = pre.headers.get('www-authenticate') || ''
            if (www) {
              const target = await ensureWalletTempoChainFromChallenge(www)
              if (target) resolvedNetwork = target
            }
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

        const url = '/api/market/kicksdb/search'

        try {
          res = await makeMppx('push').fetch(url, requestInit)
          pushLog('Live pay strategy: push mode.')
        } catch (pushErr) {
          const pushMessage = getErrorMessage(pushErr)
          pushLog(`Push mode failed: ${pushMessage}`)
          const lower = pushMessage.toLowerCase()
          // If user rejected the wallet signature/tx, do not retry.
          const userRejected =
            lower.includes('user rejected') || lower.includes('user denied') || lower.includes('denied') || lower.includes('rejected')
          if (userRejected) throw new Error(`MetaMask push failed: ${pushMessage}`)

          // Retry with pull-mode when push fails (MetaMask gas estimation is
          // frequently flaky in this demo environment).
          res = await makeMppx('pull').fetch(url, requestInit)
          pushLog('Live pay strategy fallback: pull mode.')
        }
      } else {
        res = await fetch('/api/market/kicksdb/search', requestInit)
      }

      const { data, raw } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || data?.details || raw || 'KicksDB search failed')
      const items = Array.isArray(data?.result?.data) ? data.result.data.length : 0
      setSummary(`Products returned: ${items}`)
      setStatus('ok')
      if (paymentMode === 'live' && resolvedNetwork === 'testnet') {
        // If testnet worked once, remember it so we won't block next time.
        window.localStorage.setItem('kicksdb_tempo_testnet_supported', 'true')
        setTempoTestnetEnabledForKicks(true)
      }
      pushLog(`Search succeeded for "${query}" in ${market}.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus('error')
      setError(message)
      pushLog(`Search failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>KicksDB Dashboard</h1>
        <p>Dedicated sneaker market intelligence testing page powered by KicksDB.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>KicksDB Search</h2>
          <div className="field-grid">
            <label>
              Query
              <input value={query} onChange={(e) => setQuery(e.target.value)} disabled={loading} />
            </label>
            <label>
              Market
              <input value={market} onChange={(e) => setMarket(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Per page
              <input value={perPage} onChange={(e) => setPerPage(e.target.value)} disabled={loading} />
            </label>
          </div>
          <div className="field-grid">
            <label>
              Payment Mode
              <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PaymentMode)} disabled={loading}>
                <option value="live">Live (Tempo MPP)</option>
                <option value="simulate">Simulate</option>
              </select>
            </label>
            <label>
              Network
              <select value={network} disabled={true}>
                <option value="mainnet">Tempo mainnet</option>
                {tempoTestnetEnabledForKicks ? <option value="testnet">Tempo testnet</option> : null}
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="secondary" onClick={connectWallet} disabled={loading}>
              {walletAddress ? `Wallet: ${walletAddress.slice(0, 10)}...` : 'Connect Wallet'}
            </button>
          </div>
          <div className="actions">
            <button onClick={runSearch} disabled={loading}>
              {loading ? 'Searching...' : 'Run KicksDB Search'}
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
        <h3>KicksDB API Contract</h3>
        <div className="api-list">
          <code>POST /api/market/kicksdb/search</code>
        </div>
      </section>
    </main>
  )
}

