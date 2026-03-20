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

const shortValue = (value: string, keep = 34) => {
  if (!value) return value
  if (value.length <= keep) return value
  return `${value.slice(0, keep)}...`
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

/** Prefer upstream `details` when the server only returns a generic error label. */
const stableTravelErrorMessage = (
  dataObj: { error?: string; details?: unknown } | null,
  text: string,
) => {
  const generic = 'StableTravel request failed.'
  const err = dataObj?.error
  const d = dataObj?.details
  const detailStr =
    d == null ? '' : typeof d === 'string' ? d : JSON.stringify(d)
  if (err === generic && detailStr) return detailStr
  if (detailStr && err) return `${err} ${detailStr}`
  return err || detailStr || text || generic
}

export default function TravelApp() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([
    'Travel ops dashboard initialized. Run StableTravel, Aviationstack, or Google Maps checks.',
  ])

  const [walletAddress, setWalletAddress] = useState('')

  const [origin, setOrigin] = useState('JFK')
  const [destination, setDestination] = useState('LAX')
  const [departureDate, setDepartureDate] = useState('2026-07-10')
  const [stableSummary, setStableSummary] = useState('—')

  const [flightIata, setFlightIata] = useState('AA100')
  const [flightStatus, setFlightStatus] = useState('active')
  const [aviationSummary, setAviationSummary] = useState('—')

  const [address, setAddress] = useState('1600 Amphitheatre Parkway, Mountain View, CA')
  const [mapsSummary, setMapsSummary] = useState('—')

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))

  const parseResponse = async (res: Response) => {
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return { data, text }
  }

  const addTempoMainnet = async () => {
    if (!window.ethereum) throw new Error('Wallet not found. Install Tempo Wallet or MetaMask.')
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
        },
      ],
    })
  }

  const switchWalletToMainnet = async () => {
    if (!window.ethereum) throw new Error('Wallet not found. Install Tempo Wallet or MetaMask.')
    const chain = tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    } catch (err) {
      const e = err as { code?: number }
      if (e?.code === 4902) {
        await addTempoMainnet()
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        })
        return
      }
      throw err
    }
  }

  /** StableTravel (official partner) uses Tempo mainnet only; align wallet if challenge says mainnet. */
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
      pushLog(`Wallet connected: ${selected.slice(0, 10)}...`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const runStableTravel = async () => {
    setLoading(true)
    setError('')
    try {
      if (!walletAddress) throw new Error('Connect wallet before running StableTravel (live payment).')

      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originLocationCode: origin,
          destinationLocationCode: destination,
          departureDate,
          adults: 1,
          max: 3,
        }),
      }

      // Preflight: if x402 challenge targets mainnet, switch wallet before `mppx`.
      try {
        const pre = await fetch('/api/travel/stable/flights-search', requestInit)
        if (pre.status === 402) {
          const www = pre.headers.get('www-authenticate') || ''
          if (www) await ensureWalletMainnetFromChallenge(www)
        }
      } catch {
        // Ignore; we'll still try mainnet below.
      }

      await switchWalletToMainnet()

      const chain = tempoMainnetChain
      const walletClient = createWalletClient({
        chain,
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
              getClient: async () => walletClient,
            }),
          ],
          polyfill: false,
        })

      const url = '/api/travel/stable/flights-search'
      let res: Response
      try {
        res = await makeMppx('push').fetch(url, requestInit)
      } catch {
        res = await makeMppx('pull').fetch(url, requestInit)
      }

      const { data, text } = await parseResponse(res)
      const dataObj = data as
        | { error?: string; details?: string; result?: { data?: unknown[] } }
        | null

      if (!res.ok) {
        throw new Error(stableTravelErrorMessage(dataObj, text))
      }

      const offers = Array.isArray(dataObj?.result?.data) ? dataObj.result!.data!.length : 0
      setStableSummary(`Offers: ${offers}`)
      pushLog(`StableTravel query succeeded (${origin} -> ${destination}).`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`StableTravel query failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const runAviationstack = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/travel/aviationstack/flights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flight_iata: flightIata, flight_status: flightStatus, limit: 3 }),
      })
      const { data, text } = await parseResponse(res)
      type AviationPayload = { error?: string; details?: string; result?: { data?: unknown[] } }
      const dataObj = data as AviationPayload | null
      if (!res.ok) throw new Error(dataObj?.error || dataObj?.details || text || 'Aviationstack request failed')
      const flights = Array.isArray(dataObj?.result?.data) ? dataObj!.result!.data!.length : 0
      setAviationSummary(`Flights: ${flights}`)
      pushLog(`Aviationstack lookup succeeded (${flightIata}).`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Aviationstack lookup failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const runGoogleMaps = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/travel/googlemaps/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const { data, text } = await parseResponse(res)
      type GoogleMapsPayload = {
        error?: string
        details?: string
        result?: {
          results?: Array<{
            geometry?: { location?: { lat?: unknown; lng?: unknown } }
          }>
        }
      }
      const dataObj = data as GoogleMapsPayload | null
      if (!res.ok) throw new Error(dataObj?.error || dataObj?.details || text || 'Google Maps request failed')

      const results = dataObj?.result?.results
      const first = Array.isArray(results) && results.length > 0 ? results[0] : null
      const location = first?.geometry?.location

      const latNum = Number(location?.lat)
      const lngNum = Number(location?.lng)
      if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
        setMapsSummary(`Coordinates: ${latNum}, ${lngNum}`)
      } else {
        const count = Array.isArray(results) ? results.length : 0
        setMapsSummary(`Results: ${count}`)
      }
      pushLog('Google Maps geocode succeeded.')
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Google Maps geocode failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Travel Ops Dashboard</h1>
        <p>Dedicated testing page for StableTravel, Aviationstack, and Google Maps integrations.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h3>StableTravel Search</h3>
          <div className="field-grid">
            <label>
              Origin (IATA)
              <input value={origin} onChange={(e) => setOrigin(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Destination (IATA)
              <input value={destination} onChange={(e) => setDestination(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Departure date
              <input value={departureDate} onChange={(e) => setDepartureDate(e.target.value)} disabled={loading} />
            </label>
            <p className="intent" style={{ gridColumn: '1 / -1', margin: 0 }}>
              StableTravel uses <strong>Tempo mainnet</strong> (official partner).
            </p>
            <label>
              Wallet
              <input value={walletAddress} readOnly placeholder="Connect wallet first" />
            </label>
          </div>
          <div className="actions">
            <button className="secondary" onClick={connectWallet} disabled={loading || !!walletAddress}>
              {walletAddress ? 'Wallet Connected' : 'Connect Wallet'}
            </button>
            <button onClick={runStableTravel} disabled={loading}>
              {loading ? 'Querying...' : 'Run StableTravel'}
            </button>
          </div>
          <p className="intent">Result: <strong>{stableSummary}</strong></p>
        </article>

        <article className="card">
          <h3>Aviationstack Tracking</h3>
          <div className="field-grid">
            <label>
              Flight IATA
              <input value={flightIata} onChange={(e) => setFlightIata(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Status filter
              <input value={flightStatus} onChange={(e) => setFlightStatus(e.target.value)} disabled={loading} />
            </label>
          </div>
          <div className="actions">
            <button onClick={runAviationstack} disabled={loading}>
              {loading ? 'Querying...' : 'Run Aviationstack'}
            </button>
          </div>
          <p className="intent">Result: <strong>{aviationSummary}</strong></p>
        </article>
      </section>

      <section className="grid">
        <article className="card">
          <h3>Google Maps Geocode</h3>
          <div className="field-grid">
            <label>
              Address
              <input value={address} onChange={(e) => setAddress(e.target.value)} disabled={loading} />
            </label>
          </div>
          <div className="actions">
            <button onClick={runGoogleMaps} disabled={loading}>
              {loading ? 'Querying...' : 'Run Google Maps'}
            </button>
          </div>
          <p className="intent">Result: <strong>{mapsSummary}</strong></p>
        </article>

        <article className="card">
          <h3>Latest actions</h3>
          {error ? <p className="error">{error}</p> : null}
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{shortValue(entry, 120)}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card api">
        <h3>Travel API Contract</h3>
        <div className="api-list">
          <code>POST /api/travel/stable/flights-search</code>
          <code>POST /api/travel/aviationstack/flights</code>
          <code>POST /api/travel/googlemaps/geocode</code>
        </div>
      </section>
    </main>
  )
}
