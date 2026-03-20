import { useState } from 'react'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'
import { createWalletClient } from 'viem'
import { tempo as tempoMainnet } from 'viem/chains'
import { tempoActions } from 'viem/tempo'
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

export default function WeatherApp() {
  const [lat, setLat] = useState('34.0522')
  const [lon, setLon] = useState('-118.2437')
  const [units, setUnits] = useState<'metric' | 'imperial' | 'standard'>('metric')

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [resultJson, setResultJson] = useState('')
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'Weather dashboard initialized. Connect wallet on Tempo mainnet for MPP-paid OpenWeather (or set OPENWEATHER_API_KEY on server).',
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

  const runMppFetch = async (url: string, init: RequestInit) => {
    await switchWalletToMainnet()
    try {
      const pre = await fetch(url, init)
      if (pre.status === 402) {
        const www = pre.headers.get('www-authenticate') || ''
        if (www) await ensureWalletMainnetFromChallenge(www)
      }
    } catch {
      // ignore
    }
    try {
      return await makeMppx('push').fetch(url, init)
    } catch {
      pushLog('OpenWeather: retry with pull-mode MPP.')
      return await makeMppx('pull').fetch(url, init)
    }
  }

  const fetchWeather = async () => {
    if (!walletAddress) {
      setError('Connect wallet on Tempo mainnet first (or configure OPENWEATHER_API_KEY on the server and use the hub demo).')
      return
    }
    const latNum = Number(lat)
    const lonNum = Number(lon)
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      setError('Enter valid lat and lon.')
      return
    }

    setLoading(true)
    setError('')
    setStatus('idle')
    setResultJson('')
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: latNum,
          lon: lonNum,
          units,
        }),
      }
      const res = await runMppFetch('/api/travel/openweather/current', requestInit)
      const { data, raw } = await parseResponse(res)
      const dataObj = data as { error?: string; details?: unknown; result?: unknown; hint?: string } | null
      if (!res.ok) {
        throw new Error(formatApiError(dataObj, raw))
      }
      const result = dataObj?.result
      setResultJson(
        typeof result === 'string' ? result : JSON.stringify(result ?? dataObj, null, 2),
      )
      const main = result && typeof result === 'object' && result !== null ? (result as { main?: { temp?: number } }).main : null
      const weatherArr =
        result && typeof result === 'object' && result !== null
          ? (result as { weather?: { main?: string }[] }).weather
          : null
      const condition = Array.isArray(weatherArr) && weatherArr[0]?.main ? weatherArr[0].main : null
      const temp = main?.temp
      setStatus('ok')
      setSummary(
        temp != null || condition
          ? `${condition || 'Weather'} · ${temp != null ? `${temp}° (${units})` : 'temp n/a'}`
          : 'OpenWeather response received',
      )
      pushLog('Current weather request succeeded.')
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
        <h1>Weather</h1>
        <p>
          OpenWeather current conditions via{' '}
          <a href="https://weather.mpp.paywithlocus.com" target="_blank" rel="noreferrer">
            MPP host
          </a>{' '}
          on <strong>Tempo mainnet</strong> (wallet-paid x402 / MPP), or optional{' '}
          <code>OPENWEATHER_API_KEY</code> on the server.
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p className="intent" style={{ margin: '0 0 0.75rem' }}>
          Connect a wallet on Tempo mainnet to pay for the lookup when no server API key is set.
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
          <h2>Current weather</h2>
          <div className="field-grid">
            <label>
              Latitude
              <input value={lat} onChange={(e) => setLat(e.target.value)} disabled={loading} inputMode="decimal" />
            </label>
            <label>
              Longitude
              <input value={lon} onChange={(e) => setLon(e.target.value)} disabled={loading} inputMode="decimal" />
            </label>
            <label>
              Units
              <select value={units} onChange={(e) => setUnits(e.target.value as typeof units)} disabled={loading}>
                <option value="metric">metric (°C)</option>
                <option value="imperial">imperial (°F)</option>
                <option value="standard">standard (K)</option>
              </select>
            </label>
          </div>
          <div className="actions">
            <button onClick={fetchWeather} disabled={loading || !walletAddress}>
              {loading ? 'Fetching…' : 'Get current weather'}
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
            {log.map((entry, i) => (
              <li key={`${i}-${entry.slice(0, 48)}`}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      {resultJson ? (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h3>Result</h3>
          <pre
            style={{
              margin: 0,
              padding: '0.75rem',
              background: '#fafafa',
              borderRadius: '0.5rem',
              border: '1px solid #e4e4e7',
              overflow: 'auto',
              maxHeight: 'min(70vh, 520px)',
              fontSize: '0.8rem',
              lineHeight: 1.45,
            }}
          >
            {resultJson}
          </pre>
        </section>
      ) : null}

      <section className="card api">
        <h3>API</h3>
        <div className="api-list">
          <code>POST /api/travel/openweather/current</code>
        </div>
      </section>
    </main>
  )
}
