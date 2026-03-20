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

/**
 * Example paths from the MPP catalog — see https://mpp.dev/services#fal and
 * https://fal.ai/docs/llms.txt
 */
const ENDPOINT_PRESETS = [
  { path: '/fal-ai/flux/dev', label: 'FLUX.1 [dev] (text-to-image)' },
  { path: '/fal-ai/flux/schnell', label: 'FLUX.1 [schnell]' },
  { path: '/fal-ai/stable-diffusion-v3.5-large', label: 'SD 3.5 Large' },
  { path: '/fal-ai/stable-video', label: 'Stable Video (image→video)' },
  { path: '/xai/grok-imagine-image', label: 'Grok Imagine (image)' },
] as const

const DEFAULT_BODY_JSON = `{
  "prompt": "A futuristic city skyline at sunset, cinematic lighting",
  "image_size": "square_hd"
}`

export default function FalApp() {
  const [endpointPath, setEndpointPath] = useState('/fal-ai/flux/dev')
  const [bodyJson, setBodyJson] = useState(DEFAULT_BODY_JSON)

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [assistantPreview, setAssistantPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'fal.ai (MPP) — POST model endpoints. Connect wallet on Tempo mainnet or set FAL_API_KEY on the server.',
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
          `Insufficient USDC on Tempo mainnet for the MPP session deposit: need ~${formatTip20Usdc(depositNeeded)} USDC (max ${TEMPO_MPP_SESSION_MAX_DEPOSIT} via VITE_TEMPO_MPP_MAX_DEPOSIT), have ~${formatTip20Usdc(bal)} USDC. Add USDC or set FAL_API_KEY on the server.`,
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
        pushLog(`fal MPP (MetaMask): push failed: ${getErrorMessage(err)}`)
        return failPayment(err)
      }
    }

    try {
      return await fetchPay('pull')
    } catch {
      pushLog('fal MPP: retry with push-mode MPP.')
      try {
        return await fetchPay('push')
      } catch (err) {
        return failPayment(err)
      }
    }
  }

  const previewFromResult = (result: unknown): string => {
    if (result == null) return ''
    if (typeof result === 'object' && result !== null) {
      const images = (result as { images?: { url?: string }[] }).images
      if (Array.isArray(images) && images[0]?.url) return `Image URL: ${images[0].url}`
      const video = (result as { video?: { url?: string } }).video
      if (video?.url) return `Video URL: ${video.url}`
    }
    return typeof result === 'string' ? result : JSON.stringify(result).slice(0, 500)
  }

  const sendInference = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure FAL_API_KEY on the server).')
      return
    }
    const path = endpointPath.trim().replace(/\s+/g, '')
    if (!path || !path.startsWith('/')) {
      setError('Endpoint path must start with / (e.g. /fal-ai/flux/dev).')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(bodyJson)
    } catch {
      setError('Request body must be valid JSON.')
      return
    }

    const safePath = path.startsWith('/') ? path : `/${path}`
    const segments = safePath.split('/').filter(Boolean)
    const encoded = segments.map(encodeURIComponent).join('/')
    const requestUrl = `/api/fal/${encoded}`

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch(requestUrl, {
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
      setSummary('Inference response received')
      pushLog(`POST ${safePath} succeeded.`)
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

  return (
    <main className="app">
      <header className="hero">
        <h1>fal.ai (MPP)</h1>
        <p>
          Image, video, and audio generation (600+ models) via{' '}
          <a href="https://fal.mpp.tempo.xyz" target="_blank" rel="noreferrer">
            fal.mpp.tempo.xyz
          </a>{' '}
          on <strong>Tempo mainnet</strong> (MPP / x402). Service catalog:{' '}
          <a href="https://mpp.dev/services#fal" target="_blank" rel="noreferrer">
            mpp.dev — fal
          </a>
          . Full documentation index:{' '}
          <a href="https://fal.ai/docs/llms.txt" target="_blank" rel="noreferrer">
            fal.ai/docs/llms.txt
          </a>
          . Optional server key: <code>FAL_API_KEY</code> (<code>Authorization: Bearer</code>).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay when no <code>FAL_API_KEY</code> is set on the server.
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
        <h2 style={{ marginTop: 0 }}>Model endpoint</h2>
        <p className="intent" style={{ marginTop: 0 }}>
          <code>POST /fal-ai/…</code>, <code>POST /xai/…</code>, or dynamic <code>POST /fal-ai/:namespace/:model</code>{' '}
          per the catalog. Pricing varies by model (see{' '}
          <a href="https://mpp.dev/services#fal" target="_blank" rel="noreferrer">
            mpp.dev
          </a>
          ).
        </p>
        <div className="field-grid">
          <label>
            Preset
            <select
              value={ENDPOINT_PRESETS.some((p) => p.path === endpointPath) ? endpointPath : 'custom'}
              onChange={(e) => {
                const v = e.target.value
                if (v !== 'custom') setEndpointPath(v)
              }}
              disabled={loading}
            >
              {ENDPOINT_PRESETS.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom path…</option>
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Path (must start with <code>/</code>)
            <input
              value={endpointPath}
              onChange={(e) => setEndpointPath(e.target.value)}
              disabled={loading}
              placeholder="/fal-ai/flux/dev"
            />
          </label>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Request body (JSON)</h2>
          <p className="intent" style={{ marginTop: 0 }}>
            Inputs depend on the model — see{' '}
            <a href="https://fal.ai/docs/llms.txt" target="_blank" rel="noreferrer">
              fal docs
            </a>{' '}
            for schema per endpoint.
          </p>
          <textarea
            rows={16}
            value={bodyJson}
            onChange={(e) => setBodyJson(e.target.value)}
            disabled={loading}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical', width: '100%' }}
          />
          <div className="actions" style={{ marginTop: '0.75rem' }}>
            <button onClick={sendInference} disabled={loading || !walletAddress}>
              {loading ? 'Running…' : 'POST to fal MPP'}
            </button>
          </div>
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
            Proxied routes: <code>POST /api/fal/*</code> → <code>fal.mpp.tempo.xyz</code> (override with{' '}
            <code>FAL_MPP_BASE_URL</code>). See{' '}
            <a href="https://fal.ai/docs/llms.txt" target="_blank" rel="noreferrer">
              fal.ai/docs/llms.txt
            </a>
            .
          </p>
        </article>
      </section>
    </main>
  )
}
