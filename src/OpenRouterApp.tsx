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

/** OpenRouter model slugs — see https://openrouter.ai/models */
const OPENROUTER_MODEL_PRESETS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
] as const

export default function OpenRouterApp() {
  const [modelPreset, setModelPreset] = useState<(typeof OPENROUTER_MODEL_PRESETS)[number] | 'custom'>(
    'openai/gpt-4o-mini',
  )
  const [modelCustom, setModelCustom] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a concise assistant for DanceTech, Tempo, and OpenRouter. Be brief.',
  )
  const [userMessage, setUserMessage] = useState(
    'In one paragraph, what is OpenRouter and how does it relate to many LLM providers?',
  )
  const [temperature, setTemperature] = useState('0.7')

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [assistantPreview, setAssistantPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'OpenRouter (MPP) — OpenAI-compatible chat. Connect wallet on Tempo mainnet or set OPENROUTER_API_KEY on the server.',
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
          `Insufficient USDC on Tempo mainnet for the MPP session deposit: need ~${formatTip20Usdc(depositNeeded)} USDC (max ${TEMPO_MPP_SESSION_MAX_DEPOSIT} via VITE_TEMPO_MPP_MAX_DEPOSIT), have ~${formatTip20Usdc(bal)} USDC. Add USDC or set OPENROUTER_API_KEY on the server.`,
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
        pushLog(`OpenRouter MPP (MetaMask): push failed: ${getErrorMessage(err)}`)
        return failPayment(err)
      }
    }

    try {
      return await fetchPay('pull')
    } catch {
      pushLog('OpenRouter MPP: retry with push-mode MPP.')
      try {
        return await fetchPay('push')
      } catch (err) {
        return failPayment(err)
      }
    }
  }

  const resolvedModel = () =>
    modelPreset === 'custom' ? modelCustom.trim() || 'openai/gpt-4o-mini' : modelPreset

  const sendChat = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure OPENROUTER_API_KEY on the server).')
      return
    }
    const msg = userMessage.trim()
    if (!msg) {
      setError('Enter a user message.')
      return
    }
    const temp = Number(temperature)
    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() })
    messages.push({ role: 'user', content: msg })

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch('/api/openrouter/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolvedModel(),
          messages,
          ...(Number.isFinite(temp) ? { temperature: temp } : {}),
        }),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      const choices =
        result && typeof result === 'object' && result !== null
          ? (result as { choices?: { message?: { content?: string } }[] }).choices
          : null
      const text =
        Array.isArray(choices) && choices[0]?.message?.content
          ? String(choices[0].message.content).trim()
          : ''
      setAssistantPreview(text)
      setStatus('ok')
      setSummary(text ? `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : 'Response received')
      pushLog('POST /v1/chat/completions succeeded.')
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
        <h1>OpenRouter (MPP)</h1>
        <p>
          Unified chat via{' '}
          <a href="https://openrouter.mpp.tempo.xyz" target="_blank" rel="noreferrer">
            openrouter.mpp.tempo.xyz
          </a>{' '}
          on <strong>Tempo mainnet</strong> (MPP / x402). Catalog:{' '}
          <a href="https://mpp.dev/services#openrouter" target="_blank" rel="noreferrer">
            mpp.dev — OpenRouter
          </a>
          . Documentation index:{' '}
          <a href="https://openrouter.ai/docs/llms.txt" target="_blank" rel="noreferrer">
            openrouter.ai/docs/llms.txt
          </a>{' '}
          (links to Quickstart, models, API reference). Optional server key: <code>OPENROUTER_API_KEY</code> (
          <code>Authorization: Bearer</code>).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay when no <code>OPENROUTER_API_KEY</code> is set on the server.
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
          <h2>Chat completions</h2>
          <p className="intent" style={{ marginTop: 0 }}>
            <code>POST /v1/chat/completions</code> — OpenAI-compatible body; model ids use OpenRouter slugs (e.g.{' '}
            <code>openai/gpt-4o-mini</code>). See{' '}
            <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">
              openrouter.ai/models
            </a>{' '}
            in the docs.
          </p>
          <div className="field-grid">
            <label>
              Model
              <select
                value={modelPreset}
                onChange={(e) => {
                  const v = e.target.value
                  setModelPreset(v === 'custom' ? 'custom' : (v as (typeof OPENROUTER_MODEL_PRESETS)[number]))
                }}
                disabled={loading}
              >
                {OPENROUTER_MODEL_PRESETS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="custom">Other…</option>
              </select>
            </label>
            {modelPreset === 'custom' ? (
              <label style={{ gridColumn: '1 / -1' }}>
                Custom model slug
                <input
                  value={modelCustom}
                  onChange={(e) => setModelCustom(e.target.value)}
                  disabled={loading}
                  placeholder="e.g. mistralai/mistral-small-3.1-24b-instruct:free"
                />
              </label>
            ) : null}
            <label>
              Temperature
              <input
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                disabled={loading}
                inputMode="decimal"
              />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              System (optional)
              <textarea
                rows={2}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={loading}
                style={{ fontFamily: 'inherit', resize: 'vertical' }}
              />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              User message
              <textarea
                rows={5}
                value={userMessage}
                onChange={(e) => setUserMessage(e.target.value)}
                disabled={loading}
                style={{ fontFamily: 'inherit', resize: 'vertical' }}
              />
            </label>
          </div>
          <div className="actions">
            <button onClick={sendChat} disabled={loading || !walletAddress}>
              {loading ? 'Sending…' : 'Send chat completion'}
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
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Assistant</h3>
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
            Proxied route: <code>POST /api/openrouter/v1/chat/completions</code> →{' '}
            <code>openrouter.mpp.tempo.xyz</code>.
          </p>
        </article>
      </section>
    </main>
  )
}
