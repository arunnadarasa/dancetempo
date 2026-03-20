import { useEffect, useState } from 'react'
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

/** Common chat models for `openai.mpp.tempo.xyz` / OpenAI-compatible API. */
const OPENAI_MODEL_PRESETS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-mini',
  'o1-preview',
] as const

const IMAGE_MODELS = ['dall-e-3', 'dall-e-2'] as const
const IMAGE_SIZES_D3 = ['1024x1024', '1792x1024', '1024x1792'] as const
const IMAGE_SIZES_D2 = ['256x256', '512x512', '1024x1024'] as const

const SPEECH_MODELS = ['tts-1', 'tts-1-hd'] as const
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

const TRANSCRIBE_MODELS = ['whisper-1'] as const

type OpenAiTab = 'chat' | 'images' | 'speech' | 'transcribe'

export default function OpenAIApp() {
  const [activeTab, setActiveTab] = useState<OpenAiTab>('chat')
  const [modelPreset, setModelPreset] = useState<(typeof OPENAI_MODEL_PRESETS)[number] | 'custom'>('gpt-4o-mini')
  const [modelCustom, setModelCustom] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful assistant for DanceTech and Tempo payments. Be concise.',
  )
  const [userMessage, setUserMessage] = useState('What is MPP on Tempo in one paragraph?')
  const [temperature, setTemperature] = useState('0.7')

  const [imageModel, setImageModel] = useState<(typeof IMAGE_MODELS)[number]>('dall-e-3')
  const [imagePrompt, setImagePrompt] = useState('Minimal dance studio at golden hour, wide shot, no text')
  const [imageSize, setImageSize] = useState<string>('1024x1024')
  const [imageN, setImageN] = useState('1')

  const [speechModel, setSpeechModel] = useState<(typeof SPEECH_MODELS)[number]>('tts-1')
  const [speechVoice, setSpeechVoice] = useState<(typeof VOICES)[number]>('alloy')
  const [speechInput, setSpeechInput] = useState('Hello — this is a test of text to speech on Tempo MPP.')

  const [transcribeModel, setTranscribeModel] = useState<(typeof TRANSCRIBE_MODELS)[number]>('whisper-1')
  const [transcribeFile, setTranscribeFile] = useState<File | null>(null)

  const imageSizesForModel = imageModel === 'dall-e-3' ? IMAGE_SIZES_D3 : IMAGE_SIZES_D2
  useEffect(() => {
    const allowed = imageModel === 'dall-e-3' ? IMAGE_SIZES_D3 : IMAGE_SIZES_D2
    setImageSize((prev) => ((allowed as readonly string[]).includes(prev) ? prev : allowed[0]))
  }, [imageModel])

  const [imagePreviewSrc, setImagePreviewSrc] = useState<string | null>(null)
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null)

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [assistantPreview, setAssistantPreview] = useState('')
  const [transcriptOut, setTranscriptOut] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'OpenAI (MPP) initialized. Chat, images, speech & transcription — connect wallet on Tempo mainnet or set OPENAI_API_KEY on the server.',
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

  /** Read-only client via public RPC (wallet transport can mis-handle balance reads vs chain). */
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
          `Insufficient USDC on Tempo mainnet for the MPP session deposit: need ~${formatTip20Usdc(depositNeeded)} USDC (max ${TEMPO_MPP_SESSION_MAX_DEPOSIT} via VITE_TEMPO_MPP_MAX_DEPOSIT), have ~${formatTip20Usdc(bal)} USDC. Add USDC or set OPENAI_API_KEY on the server.`,
        )
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Insufficient USDC')) throw e
      // Ignore RPC flakiness; payment flow will surface a clearer error if needed.
    }

    const isMetaMask = Boolean(window.ethereum?.isMetaMask)
    const fetchPay = (mode: 'push' | 'pull') => makeMppx(mode).fetch(url, init)

    const failPayment = (err: unknown): never => {
      throw new Error(appendMppPaymentHints(getErrorMessage(err)))
    }

    // MetaMask: use push (bundled txs) only — pull uses eth_signTransaction + gas estimate and often fails on Tempo.
    // Other wallets (e.g. Tempo Wallet): try pull first, then push (matches AgentMail inbox pattern).
    if (isMetaMask) {
      try {
        return await fetchPay('push')
      } catch (err) {
        pushLog(`OpenAI MPP (MetaMask): push failed: ${getErrorMessage(err)}`)
        return failPayment(err)
      }
    }

    try {
      return await fetchPay('pull')
    } catch {
      pushLog('OpenAI MPP: retry with push-mode MPP.')
      try {
        return await fetchPay('push')
      } catch (err) {
        return failPayment(err)
      }
    }
  }

  const sendChat = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure OPENAI_API_KEY on the server).')
      return
    }
    setImagePreviewSrc(null)
    setTranscriptOut('')
    if (audioPreviewUrl?.startsWith('blob:')) URL.revokeObjectURL(audioPreviewUrl)
    setAudioPreviewUrl(null)
    const msg = userMessage.trim()
    if (!msg) {
      setError('Enter a user message.')
      return
    }
    const temp = Number(temperature)
    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() })
    }
    messages.push({ role: 'user', content: msg })

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setAssistantPreview('')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:
            modelPreset === 'custom'
              ? modelCustom.trim() || 'gpt-4o-mini'
              : modelPreset,
          messages,
          ...(Number.isFinite(temp) ? { temperature: temp } : {}),
        }),
      }
      const res = await runMppFetch('/api/openai/chat/completions', requestInit)
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) {
        throw new Error(formatApiError(dataObj, raw))
      }
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
      pushLog('Chat completions request succeeded.')
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

  const runOpenAiJson = async (path: string, body: unknown, okLog: string) => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure OPENAI_API_KEY on the server).')
      return
    }
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setImagePreviewSrc(null)
    setAssistantPreview('')
    setTranscriptOut('')
    try {
      const res = await runMppFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2))
      setStatus('ok')
      setSummary('Response received')
      pushLog(okLog)
      return result
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      setSummary('—')
      pushLog(`Request failed: ${message}`)
      return null
    } finally {
      setLoading(false)
    }
  }

  const sendImage = async () => {
    if (!imagePrompt.trim()) {
      setError('Enter an image prompt.')
      return
    }
    const nRaw = Math.min(10, Math.max(1, Number.parseInt(imageN, 10) || 1))
    const n = imageModel === 'dall-e-3' ? 1 : nRaw
    const body: Record<string, unknown> = {
      model: imageModel,
      prompt: imagePrompt.trim(),
      n,
      size: imageSize,
    }
    const result = await runOpenAiJson('/api/openai/images/generations', body, 'Image generation succeeded.')
    if (!result || typeof result !== 'object') return
    const dataArr = (result as { data?: { url?: string; b64_json?: string }[] }).data
    const first = Array.isArray(dataArr) ? dataArr[0] : null
    if (first?.url) setImagePreviewSrc(first.url)
    else if (first?.b64_json) setImagePreviewSrc(`data:image/png;base64,${first.b64_json}`)
    else setImagePreviewSrc(null)
  }

  const sendSpeech = async () => {
    if (!speechInput.trim()) {
      setError('Enter text to speak.')
      return
    }
    if (audioPreviewUrl?.startsWith('blob:')) URL.revokeObjectURL(audioPreviewUrl)
    setAudioPreviewUrl(null)
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setImagePreviewSrc(null)
    setAssistantPreview('')
    setTranscriptOut('')
    try {
      const res = await runMppFetch('/api/openai/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: speechModel,
          voice: speechVoice,
          input: speechInput.trim(),
        }),
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      setResultJson(JSON.stringify(dataObj?.result ?? dataObj, null, 2))
      const r = dataObj?.result as { audio_base64?: string; mime?: string } | undefined
      if (r?.audio_base64 && r.mime) {
        const u = `data:${r.mime};base64,${r.audio_base64}`
        setAudioPreviewUrl(u)
      }
      setStatus('ok')
      setSummary('Audio ready')
      pushLog('Text-to-speech succeeded.')
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      setSummary('—')
      pushLog(`Speech failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const sendTranscribe = async (file: File | null) => {
    if (!file) {
      setError('Choose an audio file (e.g. mp3, m4a, webm).')
      return
    }
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first.')
      return
    }
    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    setImagePreviewSrc(null)
    setAssistantPreview('')
    setTranscriptOut('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('model', transcribeModel)
      const res = await runMppFetch('/api/openai/audio/transcriptions', {
        method: 'POST',
        body: fd,
      })
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) throw new Error(formatApiError(dataObj, raw))
      const result = dataObj?.result
      setResultJson(typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2))
      const text =
        result && typeof result === 'object' && result !== null && 'text' in result
          ? String((result as { text?: string }).text ?? '')
          : ''
      setTranscriptOut(text)
      setStatus('ok')
      setSummary(text ? text.slice(0, 100) + (text.length > 100 ? '…' : '') : 'Transcription received')
      pushLog('Transcription succeeded.')
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      setSummary('—')
      pushLog(`Transcribe failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>OpenAI (MPP)</h1>
        <p>
          Chat, images, speech &amp; transcription via{' '}
          <a href="https://openai.mpp.tempo.xyz" target="_blank" rel="noreferrer">
            openai.mpp.tempo.xyz
          </a>{' '}
          on <strong>Tempo mainnet</strong> (MPP / x402), or optional <code>OPENAI_API_KEY</code> on the server.
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay for each request when no server API key is set.
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
        <div className="flow-switch" role="tablist" aria-label="OpenAI mode">
          {(
            [
              ['chat', 'Chat'],
              ['images', 'Images'],
              ['speech', 'Speech (TTS)'],
              ['transcribe', 'Transcribe'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={activeTab === key ? 'active' : 'secondary'}
              onClick={() => setActiveTab(key)}
              disabled={loading}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid">
        <article className="card">
          {activeTab === 'chat' ? (
            <>
              <h2>Chat</h2>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={modelPreset}
                    onChange={(e) => {
                      const v = e.target.value
                      setModelPreset(v === 'custom' ? 'custom' : (v as (typeof OPENAI_MODEL_PRESETS)[number]))
                    }}
                    disabled={loading}
                  >
                    {OPENAI_MODEL_PRESETS.map((m) => (
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
                      placeholder="e.g. gpt-4o-2024-08-06"
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
            </>
          ) : null}

          {activeTab === 'images' ? (
            <>
              <h2>Images</h2>
              <p className="intent" style={{ marginTop: 0 }}>
                DALL·E — <code>POST /v1/images/generations</code> (~$0.05 on MPP catalog).
              </p>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={imageModel}
                    onChange={(e) => setImageModel(e.target.value as (typeof IMAGE_MODELS)[number])}
                    disabled={loading}
                  >
                    {IMAGE_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Size
                  <select value={imageSize} onChange={(e) => setImageSize(e.target.value)} disabled={loading}>
                    {imageSizesForModel.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Count (DALL·E 3 = 1)
                  <input
                    value={imageN}
                    onChange={(e) => setImageN(e.target.value)}
                    disabled={loading || imageModel === 'dall-e-3'}
                    inputMode="numeric"
                    title="DALL·E 3 only supports n=1"
                  />
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Prompt
                  <textarea
                    rows={4}
                    value={imagePrompt}
                    onChange={(e) => setImagePrompt(e.target.value)}
                    disabled={loading}
                    style={{ fontFamily: 'inherit', resize: 'vertical' }}
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendImage} disabled={loading || !walletAddress}>
                  {loading ? 'Generating…' : 'Generate image'}
                </button>
              </div>
            </>
          ) : null}

          {activeTab === 'speech' ? (
            <>
              <h2>Text-to-speech</h2>
              <p className="intent" style={{ marginTop: 0 }}>
                <code>POST /v1/audio/speech</code> (~$0.02).
              </p>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={speechModel}
                    onChange={(e) => setSpeechModel(e.target.value as (typeof SPEECH_MODELS)[number])}
                    disabled={loading}
                  >
                    {SPEECH_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Voice
                  <select
                    value={speechVoice}
                    onChange={(e) => setSpeechVoice(e.target.value as (typeof VOICES)[number])}
                    disabled={loading}
                  >
                    {VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Text
                  <textarea
                    rows={5}
                    value={speechInput}
                    onChange={(e) => setSpeechInput(e.target.value)}
                    disabled={loading}
                    style={{ fontFamily: 'inherit', resize: 'vertical' }}
                  />
                </label>
              </div>
              <div className="actions">
                <button onClick={sendSpeech} disabled={loading || !walletAddress}>
                  {loading ? 'Synthesizing…' : 'Generate speech'}
                </button>
              </div>
            </>
          ) : null}

          {activeTab === 'transcribe' ? (
            <>
              <h2>Transcribe</h2>
              <p className="intent" style={{ marginTop: 0 }}>
                Whisper — <code>POST /v1/audio/transcriptions</code> (~$0.01). Upload an audio file.
              </p>
              <div className="field-grid">
                <label>
                  Model
                  <select
                    value={transcribeModel}
                    onChange={(e) => setTranscribeModel(e.target.value as (typeof TRANSCRIBE_MODELS)[number])}
                    disabled={loading}
                  >
                    {TRANSCRIBE_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  Audio file
                  <input
                    type="file"
                    accept="audio/*,.mp3,.m4a,.webm,.wav,.mpeg,.mpga"
                    disabled={loading}
                    onChange={(e) => setTranscribeFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void sendTranscribe(transcribeFile)}
                  disabled={loading || !walletAddress || !transcribeFile}
                >
                  {loading ? 'Transcribing…' : 'Transcribe audio'}
                </button>
              </div>
              <p className="intent" style={{ marginBottom: 0 }}>
                Choose a file, then transcribe (wallet connected).
              </p>
            </>
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
              <li key={`${i}-${entry.slice(0, 48)}`}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      {assistantPreview ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Assistant reply</h3>
          <p className="intent" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {assistantPreview}
          </p>
        </section>
      ) : null}

      {transcriptOut ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Transcript</h3>
          <p className="intent" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {transcriptOut}
          </p>
        </section>
      ) : null}

      {imagePreviewSrc ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Generated image</h3>
          <img
            src={imagePreviewSrc}
            alt="OpenAI generation"
            style={{ maxWidth: '100%', height: 'auto', borderRadius: '0.5rem', border: '1px solid #e4e4e7' }}
          />
        </section>
      ) : null}

      {audioPreviewUrl ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Speech audio</h3>
          <audio className="audio-player" controls style={{ width: '100%' }} src={audioPreviewUrl} />
        </section>
      ) : null}

      {resultJson ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Raw JSON</h3>
          <pre
            style={{
              margin: 0,
              padding: '0.75rem',
              background: '#fafafa',
              borderRadius: '0.5rem',
              border: '1px solid #e4e4e7',
              overflow: 'auto',
              maxHeight: 'min(50vh, 360px)',
              fontSize: '0.8rem',
              lineHeight: 1.45,
            }}
          >
            {resultJson}
          </pre>
        </section>
      ) : null}

      <section className="card api">
        <h3>API (proxied)</h3>
        <div className="api-list">
          <code>POST /api/openai/chat/completions</code>
          <code>POST /api/openai/images/generations</code>
          <code>POST /api/openai/audio/speech</code>
          <code>POST /api/openai/audio/transcriptions</code>
        </div>
        <p className="intent" style={{ marginBottom: 0 }}>
          Bodies match OpenAI — chat JSON, images JSON, speech JSON, transcription multipart (<code>file</code> +{' '}
          <code>model</code>).
        </p>
      </section>
    </main>
  )
}
