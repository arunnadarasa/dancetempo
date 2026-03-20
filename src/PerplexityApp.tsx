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

/** Sonar models — see https://docs.perplexity.ai/llms-full.txt */
const PERPLEXITY_CHAT_MODEL_PRESETS = [
  'sonar',
  'sonar-pro',
  'sonar-reasoning-pro',
  'sonar-deep-research',
] as const

const PERPLEXITY_EMBED_MODEL_PRESETS = ['pplx-embed-v1-4b', 'pplx-embed-v1-0.6b'] as const

const PERPLEXITY_CONTEXT_EMBED_MODEL_PRESETS = ['pplx-embed-context-v1-4b', 'pplx-embed-context-v1-0.6b'] as const

type Panel = 'chat' | 'search' | 'embed' | 'context'

export default function PerplexityApp() {
  const [panel, setPanel] = useState<Panel>('chat')

  const [modelPreset, setModelPreset] = useState<
    (typeof PERPLEXITY_CHAT_MODEL_PRESETS)[number] | 'custom'
  >('sonar-pro')
  const [modelCustom, setModelCustom] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a concise assistant for DanceTech and Tempo. Be brief.',
  )
  const [userMessage, setUserMessage] = useState(
    'In one paragraph, what is Perplexity Sonar and how does web-grounded search differ from a plain LLM?',
  )
  const [temperature, setTemperature] = useState('0.7')

  const [searchQuery, setSearchQuery] = useState('SpaceX Starship launch updates 2026')
  const [maxResults, setMaxResults] = useState('5')

  const [embedModel, setEmbedModel] = useState<
    (typeof PERPLEXITY_EMBED_MODEL_PRESETS)[number] | 'custom'
  >('pplx-embed-v1-4b')
  const [embedModelCustom, setEmbedModelCustom] = useState('')
  const [embedInput, setEmbedInput] = useState('Scientists explore the universe driven by curiosity.')

  const [ctxModel, setCtxModel] = useState<
    (typeof PERPLEXITY_CONTEXT_EMBED_MODEL_PRESETS)[number] | 'custom'
  >('pplx-embed-context-v1-4b')
  const [ctxModelCustom, setCtxModelCustom] = useState('')
  const [contextEmbedJson, setContextEmbedJson] = useState(
    JSON.stringify(
      [
        ['Curiosity begins in childhood with endless questions about the world.'],
        ['The Curiosity rover explores Mars, searching for signs of ancient life.'],
      ],
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
    'Perplexity (MPP) — chat, search, embeddings. Connect wallet on Tempo mainnet or set PERPLEXITY_API_KEY on the server.',
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
          `Insufficient USDC on Tempo mainnet for the MPP session deposit: need ~${formatTip20Usdc(depositNeeded)} USDC (max ${TEMPO_MPP_SESSION_MAX_DEPOSIT} via VITE_TEMPO_MPP_MAX_DEPOSIT), have ~${formatTip20Usdc(bal)} USDC. Add USDC or set PERPLEXITY_API_KEY on the server.`,
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
        pushLog(`Perplexity MPP (MetaMask): push failed: ${getErrorMessage(err)}`)
        return failPayment(err)
      }
    }

    try {
      return await fetchPay('pull')
    } catch {
      pushLog('Perplexity MPP: retry with push-mode MPP.')
      try {
        return await fetchPay('push')
      } catch (err) {
        return failPayment(err)
      }
    }
  }

  const resolvedChatModel = () =>
    modelPreset === 'custom' ? modelCustom.trim() || 'sonar-pro' : modelPreset

  const resolvedEmbedModel = () =>
    embedModel === 'custom' ? embedModelCustom.trim() || 'pplx-embed-v1-4b' : embedModel

  const resolvedCtxModel = () =>
    ctxModel === 'custom' ? ctxModelCustom.trim() || 'pplx-embed-context-v1-4b' : ctxModel

  const extractAssistantText = (result: unknown): string => {
    if (!result || typeof result !== 'object') return ''
    const r = result as { choices?: { message?: { content?: string } }[]; output_text?: string }
    const choices = r.choices
    if (Array.isArray(choices) && choices[0]?.message?.content) {
      return String(choices[0].message.content).trim()
    }
    if (typeof r.output_text === 'string') return r.output_text.trim()
    return ''
  }

  const sendChat = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure PERPLEXITY_API_KEY on the server).')
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
      const res = await runMppFetch('/api/perplexity/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolvedChatModel(),
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
      const text = extractAssistantText(result)
      setAssistantPreview(text)
      setStatus('ok')
      setSummary(text ? `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : 'Response received')
      pushLog('POST /perplexity/chat succeeded.')
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

  const sendSearch = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure PERPLEXITY_API_KEY on the server).')
      return
    }
    const q = searchQuery.trim()
    if (!q) {
      setError('Enter a search query.')
      return
    }
    const mr = Math.min(20, Math.max(1, parseInt(maxResults, 10) || 5))

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch('/api/perplexity/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, max_results: mr }),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      const n =
        result && typeof result === 'object' && result !== null && 'results' in result
          ? Array.isArray((result as { results?: unknown }).results)
            ? (result as { results: unknown[] }).results.length
            : 0
          : 0
      setAssistantPreview(n ? `${n} result(s)` : '')
      setStatus('ok')
      setSummary(n ? `Search: ${n} result(s)` : 'Search response received')
      pushLog('POST /perplexity/search succeeded.')
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

  const sendEmbed = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure PERPLEXITY_API_KEY on the server).')
      return
    }
    const lines = embedInput
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const input = lines.length ? lines : [embedInput.trim() || 'test']
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch('/api/perplexity/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: resolvedEmbedModel(), input }),
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
      setSummary('Embeddings response received')
      pushLog('POST /perplexity/embed succeeded.')
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

  const sendContextEmbed = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure PERPLEXITY_API_KEY on the server).')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(contextEmbedJson)
    } catch {
      setError('Context embed input must be valid JSON (nested string arrays per document).')
      return
    }
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const res = await runMppFetch('/api/perplexity/context-embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: resolvedCtxModel(), input: parsed }),
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
      setSummary('Contextual embeddings response received')
      pushLog('POST /perplexity/context-embed succeeded.')
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
      {(['chat', 'search', 'embed', 'context'] as const).map((p) => (
        <button
          key={p}
          type="button"
          className={panel === p ? undefined : 'secondary'}
          onClick={() => setPanel(p)}
          disabled={loading}
        >
          {p === 'context' ? 'Context embed' : p}
        </button>
      ))}
    </div>
  )

  return (
    <main className="app">
      <header className="hero">
        <h1>Perplexity (MPP)</h1>
        <p>
          Sonar chat, Search API, and Embeddings via{' '}
          <a href="https://perplexity.mpp.tempo.xyz" target="_blank" rel="noreferrer">
            perplexity.mpp.tempo.xyz
          </a>{' '}
          on <strong>Tempo mainnet</strong> (MPP / x402). Service catalog:{' '}
          <a href="https://mpp.dev/services#perplexity" target="_blank" rel="noreferrer">
            mpp.dev — Perplexity
          </a>
          . Full documentation index (all endpoints & guides):{' '}
          <a href="https://docs.perplexity.ai/llms-full.txt" target="_blank" rel="noreferrer">
            docs.perplexity.ai/llms-full.txt
          </a>
          . Optional server key: <code>PERPLEXITY_API_KEY</code> (<code>Authorization: Bearer</code>).
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay when no <code>PERPLEXITY_API_KEY</code> is set on the server.
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
        <h2 style={{ marginTop: 0 }}>Endpoint</h2>
        {panelButtons}
        <p className="intent" style={{ marginBottom: 0, marginTop: '0.75rem' }}>
          {panel === 'chat' && (
            <>
              <code>POST /perplexity/chat</code> — web-grounded Sonar chat (OpenAI-style{' '}
              <code>messages</code>). See Sonar quickstart in{' '}
              <a href="https://docs.perplexity.ai/llms-full.txt" target="_blank" rel="noreferrer">
                llms-full.txt
              </a>
              .
            </>
          )}
          {panel === 'search' && (
            <>
              <code>POST /perplexity/search</code> — ranked web search (e.g. <code>query</code>,{' '}
              <code>max_results</code>). See Search API in the docs index.
            </>
          )}
          {panel === 'embed' && (
            <>
              <code>POST /perplexity/embed</code> — text embeddings (<code>input</code>, <code>model</code>). See
              Embeddings quickstart.
            </>
          )}
          {panel === 'context' && (
            <>
              <code>POST /perplexity/context-embed</code> — contextualized embeddings for document chunks (
              <code>input</code> as nested arrays). See Contextualized Embeddings.
            </>
          )}
        </p>
      </section>

      <section className="grid">
        <article className="card">
          {panel === 'chat' ? (
            <>
              <h2>Chat</h2>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={modelPreset}
                    onChange={(e) => {
                      const v = e.target.value
                      setModelPreset(v === 'custom' ? 'custom' : (v as (typeof PERPLEXITY_CHAT_MODEL_PRESETS)[number]))
                    }}
                    disabled={loading}
                  >
                    {PERPLEXITY_CHAT_MODEL_PRESETS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                </label>
                {modelPreset === 'custom' ? (
                  <label style={{ gridColumn: '1 / -1' }}>
                    Custom model id
                    <input
                      value={modelCustom}
                      onChange={(e) => setModelCustom(e.target.value)}
                      disabled={loading}
                      placeholder="e.g. sonar-pro"
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
                  {loading ? 'Sending…' : 'Send chat'}
                </button>
              </div>
            </>
          ) : null}

          {panel === 'search' ? (
            <>
              <h2>Search</h2>
              <div className="field-grid">
                <label style={{ gridColumn: '1 / -1' }}>
                  Query
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    disabled={loading}
                  />
                </label>
                <label>
                  max_results (1–20)
                  <input
                    value={maxResults}
                    onChange={(e) => setMaxResults(e.target.value)}
                    disabled={loading}
                    inputMode="numeric"
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendSearch} disabled={loading || !walletAddress}>
                  {loading ? 'Searching…' : 'Search'}
                </button>
              </div>
            </>
          ) : null}

          {panel === 'embed' ? (
            <>
              <h2>Embeddings</h2>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={embedModel}
                    onChange={(e) => {
                      const v = e.target.value
                      setEmbedModel(
                        v === 'custom' ? 'custom' : (v as (typeof PERPLEXITY_EMBED_MODEL_PRESETS)[number]),
                      )
                    }}
                    disabled={loading}
                  >
                    {PERPLEXITY_EMBED_MODEL_PRESETS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                </label>
                {embedModel === 'custom' ? (
                  <label style={{ gridColumn: '1 / -1' }}>
                    Custom embedding model
                    <input
                      value={embedModelCustom}
                      onChange={(e) => setEmbedModelCustom(e.target.value)}
                      disabled={loading}
                      placeholder="pplx-embed-v1-4b"
                    />
                  </label>
                ) : null}
                <label style={{ gridColumn: '1 / -1' }}>
                  Input (one text per line; or single line)
                  <textarea
                    rows={6}
                    value={embedInput}
                    onChange={(e) => setEmbedInput(e.target.value)}
                    disabled={loading}
                    style={{ fontFamily: 'inherit', resize: 'vertical' }}
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendEmbed} disabled={loading || !walletAddress}>
                  {loading ? 'Embedding…' : 'Embed'}
                </button>
              </div>
            </>
          ) : null}

          {panel === 'context' ? (
            <>
              <h2>Contextualized embeddings</h2>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={ctxModel}
                    onChange={(e) => {
                      const v = e.target.value
                      setCtxModel(
                        v === 'custom'
                          ? 'custom'
                          : (v as (typeof PERPLEXITY_CONTEXT_EMBED_MODEL_PRESETS)[number]),
                      )
                    }}
                    disabled={loading}
                  >
                    {PERPLEXITY_CONTEXT_EMBED_MODEL_PRESETS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value="custom">Other…</option>
                  </select>
                </label>
                {ctxModel === 'custom' ? (
                  <label style={{ gridColumn: '1 / -1' }}>
                    Custom model
                    <input
                      value={ctxModelCustom}
                      onChange={(e) => setCtxModelCustom(e.target.value)}
                      disabled={loading}
                      placeholder="pplx-embed-context-v1-4b"
                    />
                  </label>
                ) : null}
                <label style={{ gridColumn: '1 / -1' }}>
                  input (JSON: array of documents, each an array of chunk strings)
                  <textarea
                    rows={12}
                    value={contextEmbedJson}
                    onChange={(e) => setContextEmbedJson(e.target.value)}
                    disabled={loading}
                    style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical' }}
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendContextEmbed} disabled={loading || !walletAddress}>
                  {loading ? 'Embedding…' : 'Context embed'}
                </button>
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
            Proxied routes: <code>POST /api/perplexity/chat</code>, <code>/search</code>, <code>/embed</code>,{' '}
            <code>/context-embed</code> → <code>perplexity.mpp.tempo.xyz</code> (override with{' '}
            <code>PERPLEXITY_MPP_BASE_URL</code>).
          </p>
        </article>
      </section>
    </main>
  )
}
