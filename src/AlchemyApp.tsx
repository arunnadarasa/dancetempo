import { useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MAINNET_RPC_HTTP,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  appendMppPaymentHints,
  formatTip20Usdc,
  parseSuggestedDepositRawFromWwwAuthenticate,
  sessionDepositRequiredRaw,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createPublicClient, createWalletClient, http } from 'viem'
import { tempo as tempoMainnet } from 'viem/chains'
import { Actions, tempoActions } from 'viem/tempo'
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

/** Common Alchemy network path segments — see https://www.alchemy.com/llms.txt */
const NETWORK_PRESETS = [
  'eth-mainnet',
  'eth-sepolia',
  'base-mainnet',
  'base-sepolia',
  'arb-mainnet',
  'opt-mainnet',
  'polygon-mainnet',
] as const

const DEFAULT_RPC_JSON = `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_blockNumber",
  "params": []
}`

type Panel = 'rpc' | 'nft-get' | 'nft-post'

export default function AlchemyApp() {
  const [panel, setPanel] = useState<Panel>('rpc')

  const [network, setNetwork] = useState<(typeof NETWORK_PRESETS)[number] | 'custom'>('eth-mainnet')
  const [networkCustom, setNetworkCustom] = useState('')

  const [rpcJson, setRpcJson] = useState(DEFAULT_RPC_JSON)

  const [nftEndpoint, setNftEndpoint] = useState('getNFTsForOwner')
  const [nftQuery, setNftQuery] = useState(
    'owner=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&pageSize=3',
  )
  const [nftPostJson, setNftPostJson] = useState(
    JSON.stringify(
      {
        addresses: ['0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d'],
        pageSize: 2,
      },
      null,
      2,
    ),
  )

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [assistantPreview, setAssistantPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'Alchemy (MPP) — Core JSON-RPC + NFT API v3. Connect wallet on Tempo mainnet or set ALCHEMY_API_KEY on the server.',
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

  const resolvedNetwork = () =>
    network === 'custom' ? networkCustom.trim() || 'eth-mainnet' : network

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

  const createTempoReadClient = () =>
    createPublicClient({
      chain: tempoMainnetChain,
      transport: http(TEMPO_MAINNET_RPC_HTTP),
    }).extend(tempoActions())

  const runMppFetch = async (url: string, init: RequestInit): Promise<Response> => {
    await switchWalletToMainnet()
    let suggestedDepositRaw: bigint | null = null
    try {
      const pre = await fetch(url, init)
      if (pre.status === 402) {
        const www = pre.headers.get('www-authenticate') || ''
        if (www) {
          await ensureWalletMainnetFromChallenge(www)
          suggestedDepositRaw = parseSuggestedDepositRawFromWwwAuthenticate(www)
        }
      }
    } catch {
      // ignore
    }

    const addr = walletAddress as `0x${string}`
    const depositNeeded = sessionDepositRequiredRaw(suggestedDepositRaw)
    try {
      const token = tempoMainnetChain.feeToken as `0x${string}`
      const bal = await Actions.token.getBalance(createTempoReadClient(), { account: addr, token })
      if (bal < depositNeeded) {
        throw new Error(
          `Insufficient USDC on Tempo mainnet for the MPP session deposit: need ~${formatTip20Usdc(depositNeeded)} USDC (max ${TEMPO_MPP_SESSION_MAX_DEPOSIT} via VITE_TEMPO_MPP_MAX_DEPOSIT), have ~${formatTip20Usdc(bal)} USDC. Add USDC or set ALCHEMY_API_KEY on the server.`,
        )
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Insufficient USDC')) throw e
    }

    const isMetaMask = Boolean(window.ethereum?.isMetaMask)
    const fetchPay = (mode: 'push' | 'pull') => makeMppx(mode).fetch(url, init)

    const failPayment = (err: unknown): never => {
      throw new Error(appendMppPaymentHints(getErrorMessage(err)))
    }

    if (isMetaMask) {
      try {
        return await fetchPay('push')
      } catch (err) {
        pushLog(`Alchemy MPP (MetaMask): push failed: ${getErrorMessage(err)}`)
        return failPayment(err)
      }
    }

    try {
      return await fetchPay('pull')
    } catch {
      pushLog('Alchemy MPP: retry with push-mode MPP.')
      try {
        return await fetchPay('push')
      } catch (err) {
        return failPayment(err)
      }
    }
  }

  const previewFromResult = (result: unknown): string => {
    if (result == null) return ''
    if (typeof result === 'object' && result !== null && 'result' in result) {
      const r = (result as { result?: unknown }).result
      return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 400)
    }
    return typeof result === 'string' ? result : JSON.stringify(result).slice(0, 400)
  }

  const sendRpc = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure ALCHEMY_API_KEY on the server).')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(rpcJson)
    } catch {
      setError('JSON-RPC body must be valid JSON.')
      return
    }
    const net = resolvedNetwork()
    const url = `/api/alchemy/${encodeURIComponent(net)}/v2`

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      setAssistantPreview(previewFromResult(result))
      setStatus('ok')
      setSummary('JSON-RPC response received')
      pushLog(`POST /${net}/v2 succeeded.`)
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

  const sendNftGet = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure ALCHEMY_API_KEY on the server).')
      return
    }
    const ep = nftEndpoint.trim().replace(/^\/+/, '')
    if (!ep) {
      setError('Enter an NFT API path segment (e.g. getNFTsForOwner).')
      return
    }
    const net = resolvedNetwork()
    const q = nftQuery.trim()
    const path = `/api/alchemy/${encodeURIComponent(net)}/nft/v3/${ep.split('/').map(encodeURIComponent).join('/')}`
    const url = q ? `${path}?${q}` : path

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch(url, { method: 'GET' })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      setAssistantPreview('')
      setStatus('ok')
      setSummary('NFT API (GET) response received')
      pushLog(`GET …/nft/v3/${ep} succeeded.`)
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

  const sendNftPost = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure ALCHEMY_API_KEY on the server).')
      return
    }
    const ep = nftEndpoint.trim().replace(/^\/+/, '')
    if (!ep) {
      setError('Enter an NFT API path segment (e.g. getNFTsForContract).')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(nftPostJson)
    } catch {
      setError('POST body must be valid JSON.')
      return
    }
    const net = resolvedNetwork()
    const path = `/api/alchemy/${encodeURIComponent(net)}/nft/v3/${ep.split('/').map(encodeURIComponent).join('/')}`
    const url = nftQuery.trim() ? `${path}?${nftQuery.trim()}` : path

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      setAssistantPreview('')
      setStatus('ok')
      setSummary('NFT API (POST) response received')
      pushLog(`POST …/nft/v3/${ep} succeeded.`)
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

  const panelButtons = (
    <div className="actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      {(['rpc', 'nft-get', 'nft-post'] as const).map((p) => (
        <button
          key={p}
          type="button"
          className={panel === p ? undefined : 'secondary'}
          onClick={() => setPanel(p)}
          disabled={loading}
        >
          {p === 'rpc' ? 'JSON-RPC' : p === 'nft-get' ? 'NFT GET' : 'NFT POST'}
        </button>
      ))}
    </div>
  )

  return (
    <main className="app">
      <header className="hero">
        <h1>Alchemy (MPP)</h1>
        <p>
          Core JSON-RPC (<code>eth_*</code>, <code>alchemy_*</code>) and NFT API v3 via{' '}
          <a href="https://mpp.alchemy.com" target="_blank" rel="noreferrer">
            mpp.alchemy.com
          </a>{' '}
          on <strong>Tempo mainnet</strong> (MPP / x402). Service catalog:{' '}
          <a href="https://mpp.dev/services#alchemy" target="_blank" rel="noreferrer">
            mpp.dev — Alchemy
          </a>
          . Documentation index:{' '}
          <a href="https://www.alchemy.com/llms.txt" target="_blank" rel="noreferrer">
            alchemy.com/llms.txt
          </a>
          . Optional server key: <code>ALCHEMY_API_KEY</code> (<code>Authorization: Bearer</code>).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay when no <code>ALCHEMY_API_KEY</code> is set on the server.
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
        <h2 style={{ marginTop: 0 }}>Network</h2>
        <div className="field-grid">
          <label>
            Alchemy network id
            <select
              value={network}
              onChange={(e) => {
                const v = e.target.value
                setNetwork(v === 'custom' ? 'custom' : (v as (typeof NETWORK_PRESETS)[number]))
              }}
              disabled={loading}
            >
              {NETWORK_PRESETS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {network === 'custom' ? (
            <label style={{ gridColumn: '1 / -1' }}>
              Custom network path
              <input
                value={networkCustom}
                onChange={(e) => setNetworkCustom(e.target.value)}
                disabled={loading}
                placeholder="e.g. eth-mainnet"
              />
            </label>
          ) : null}
        </div>
        <p className="intent" style={{ marginBottom: 0, marginTop: '0.75rem' }}>
          {panelButtons}
        </p>
        <p className="intent" style={{ marginBottom: 0, marginTop: '0.75rem' }}>
          {panel === 'rpc' && (
            <>
              <code>POST /:network/v2</code> — JSON-RPC (standard Ethereum + Alchemy methods). Catalog:{' '}
              <strong>$0.0001</strong>/call (example pricing).
            </>
          )}
          {panel === 'nft-get' && (
            <>
              <code>GET /:network/nft/v3/:endpoint</code> — NFT API v3. Example: <code>getNFTsForOwner</code> + query
              string.
            </>
          )}
          {panel === 'nft-post' && (
            <>
              <code>POST /:network/nft/v3/:endpoint</code> — NFT API v3 with JSON body. Optional query string for
              filters.
            </>
          )}
        </p>
      </section>

      <section className="grid">
        <article className="card">
          {panel === 'rpc' ? (
            <>
              <h2>JSON-RPC</h2>
              <div className="field-grid">
                <label style={{ gridColumn: '1 / -1' }}>
                  Body (JSON-RPC 2.0)
                  <textarea
                    rows={14}
                    value={rpcJson}
                    onChange={(e) => setRpcJson(e.target.value)}
                    disabled={loading}
                    style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical' }}
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendRpc} disabled={loading || !walletAddress}>
                  {loading ? 'Calling…' : 'POST JSON-RPC'}
                </button>
              </div>
            </>
          ) : null}

          {panel === 'nft-get' || panel === 'nft-post' ? (
            <>
              <h2>NFT API v3</h2>
              <div className="field-grid">
                <label style={{ gridColumn: '1 / -1' }}>
                  Path segment after <code>/nft/v3/</code> (e.g. getNFTsForOwner)
                  <input
                    value={nftEndpoint}
                    onChange={(e) => setNftEndpoint(e.target.value)}
                    disabled={loading}
                    placeholder="getNFTsForOwner"
                  />
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Query string (optional; e.g. owner=…&pageSize=…)
                  <input
                    value={nftQuery}
                    onChange={(e) => setNftQuery(e.target.value)}
                    disabled={loading}
                    placeholder="owner=0x…&pageSize=5"
                  />
                </label>
              </div>
              {panel === 'nft-post' ? (
                <div className="field-grid">
                  <label style={{ gridColumn: '1 / -1' }}>
                    POST JSON body
                    <textarea
                      rows={10}
                      value={nftPostJson}
                      onChange={(e) => setNftPostJson(e.target.value)}
                      disabled={loading}
                      style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical' }}
                    />
                  </label>
                </div>
              ) : null}
              <div className="actions">
                {panel === 'nft-get' ? (
                  <button onClick={sendNftGet} disabled={loading || !walletAddress}>
                    {loading ? 'Requesting…' : 'GET NFT API'}
                  </button>
                ) : (
                  <button onClick={sendNftPost} disabled={loading || !walletAddress}>
                    {loading ? 'Posting…' : 'POST NFT API'}
                  </button>
                )}
              </div>
            </>
          ) : null}
        </article>

        <article className="card">
          <h2>Telemetry</h2>
          <p>
            <strong>Status:</strong>{' '}
            <span className={status === 'error' ? 'error' : status === 'ok' ? 'ok' : ''}>{status}</span>
          </p>
          <p>
            <strong>Summary:</strong> {summary}
          </p>
          {error ? (
            <p className="error" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </p>
          ) : null}
          {assistantPreview ? (
            <section style={{ marginTop: '0.75rem' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Preview</h3>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  padding: '0.75rem',
                  background: 'var(--card-inner-bg, #111)',
                  borderRadius: 8,
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {assistantPreview}
              </pre>
            </section>
          ) : null}
          {resultJson ? (
            <details style={{ marginTop: '0.75rem' }}>
              <summary>Raw JSON</summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: '0.8rem',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {resultJson}
              </pre>
            </details>
          ) : null}
          <h3 style={{ marginTop: '1rem' }}>Latest actions</h3>
          <ul className="log">
            {log.map((line, i) => (
              <li key={i}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
          <p className="intent" style={{ marginTop: '1rem' }}>
            Proxied routes: <code>/api/alchemy/*</code> → <code>mpp.alchemy.com</code> (override with{' '}
            <code>ALCHEMY_MPP_BASE_URL</code>). See{' '}
            <a href="https://www.alchemy.com/llms.txt" target="_blank" rel="noreferrer">
              alchemy.com/llms.txt
            </a>
            .
          </p>
        </article>
      </section>
    </main>
  )
}
