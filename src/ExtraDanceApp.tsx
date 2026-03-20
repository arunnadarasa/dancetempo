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
import { AGENTMAIL_DEMO_INBOX_ID } from './agentmailDemo'
import {
  CORE_EXTRA_FLOW_ORDER,
  type CoreExtraFlowKey,
  coreExtraFlowCopy,
} from './danceExtraCoreFlows'
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

const DEMO_BATTLE_ID = 'battle_demo'
const DEMO_DANCER_ID = 'dancer_1'

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

const extractHexHash = (value: string) => {
  const prefixed = value.match(/0x[a-fA-F0-9]{64}/)
  if (prefixed) return prefixed[0]
  const bare = value.match(/\b[a-fA-F0-9]{64}\b/)
  return bare ? `0x${bare[0]}` : ''
}

/** Avoid dumping HTML 404 pages into telemetry; nudge when proxy hits a stale/wrong process on :8787. */
function httpFailureMessage(res: Response, text: string, data: unknown, fallback: string) {
  if (res.status === 404 && /cannot\s+post/i.test(text)) {
    return (
      'API route not found (404). Restart the backend (`npm run server` on port 8787) or run `npm run dev:full` with Vite. ' +
      'Verify: GET http://localhost:8787/api/dance-extras/live should return JSON with flowKeys.'
    )
  }
  const errObj = data && typeof data === 'object' ? (data as { error?: unknown; details?: unknown }) : null
  if (typeof errObj?.error === 'string' && errObj.error) return errObj.error
  if (errObj?.details != null) return String(errObj.details)
  const trimmed = text?.trim() ?? ''
  if (trimmed && !trimmed.startsWith('<!') && trimmed.length < 800) return trimmed
  return fallback
}

const mapLivePayError = (message: string) => {
  const lower = message.toLowerCase()
  if (lower.includes('timed out while waiting for call bundle id')) {
    return 'Wallet submitted the call bundle, but confirmation polling timed out. Check Tempo explorer.'
  }
  if (lower.includes('user rejected') || lower.includes('rejected the request')) {
    return 'Transaction approval was rejected in wallet.'
  }
  if (lower.includes('insufficientbalance') || lower.includes('amount exceeds balance')) {
    return 'Insufficient balance for this payment on selected network.'
  }
  return message
}

const MOCK_PATH: Record<CoreExtraFlowKey, string> = {
  'judge-score': '/api/judges/score',
  'cypher-micropot': '/api/cypher/micropot/contribute',
  'clip-sale': '/api/clips/sale',
  reputation: '/api/reputation/attest',
  'ai-usage': '/api/studio/ai-usage',
  'bot-action': '/api/bot/action',
  'fan-pass': '/api/fan-pass/purchase',
}

function buildFlowPayload(kind: CoreExtraFlowKey, network: Network): Record<string, unknown> {
  const net = { network }
  switch (kind) {
    case 'judge-score':
      return {
        battleId: DEMO_BATTLE_ID,
        roundId: 'round_1',
        judgeId: 'judge_1',
        dancerId: DEMO_DANCER_ID,
        score: 8.7,
        ...net,
      }
    case 'cypher-micropot':
      return { cypherId: 'cypher_demo', dancerId: DEMO_DANCER_ID, amount: 1, ...net }
    case 'clip-sale':
      return {
        clipId: 'clip_1',
        buyerId: 'buyer_1',
        totalAmount: 25,
        splits: [
          { recipientId: DEMO_DANCER_ID, share: 0.5 },
          { recipientId: 'filmer_1', share: 0.3 },
          { recipientId: 'organizer_1', share: 0.2 },
        ],
        ...net,
      }
    case 'reputation':
      return {
        issuerId: 'event_1',
        dancerId: DEMO_DANCER_ID,
        type: 'battle_winner',
        eventId: 'event_1',
        ...net,
      }
    case 'ai-usage':
      return { studioId: 'studio_1', toolId: 'ai_feedback', units: 1, mode: 'charge', ...net }
    case 'bot-action':
      return {
        eventId: 'event_1',
        actionType: 'call_time_alert',
        payload: { battleId: DEMO_BATTLE_ID },
        ...net,
      }
    case 'fan-pass':
      return { fanId: 'fan_1', tier: 'battle_pass', ...net }
  }
}

export default function ExtraDanceApp() {
  const [network, setNetwork] = useState<Network>('testnet')
  const [paymentMode, setPaymentMode] = useState<'simulate' | 'live'>('simulate')
  const [activeFlow, setActiveFlow] = useState<CoreExtraFlowKey>('judge-score')
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [summary, setSummary] = useState('—')
  const [error, setError] = useState('')
  const [lastChainId, setLastChainId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [log, setLog] = useState<string[]>([
    'Pick a flow, choose simulate or live MPP, then use one button to run the transaction.',
  ])

  const flow = coreExtraFlowCopy[activeFlow]

  const networkLabel = useMemo(
    () => (network === 'testnet' ? 'Tempo Testnet (42431)' : 'Tempo Mainnet (4217)'),
    [network],
  )

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))

  const parseResponse = async (res: Response) => {
    const text = await res.text()
    try {
      return { data: text ? JSON.parse(text) : null, text }
    } catch {
      return { data: null, text }
    }
  }

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
    if (!window.ethereum) throw new Error('Injected wallet provider is not available.')
    const chain = network === 'testnet' ? tempoTestnetChain : tempoMainnetChain
    const chainIdHex = toHexChainId(chain.id)
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    } catch (err: unknown) {
      const e = err as { code?: number }
      if (e?.code === 4902) {
        await addTempoNetwork(network)
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        })
        return
      }
      throw err
    }
  }

  const liveMppFetch = async (url: string, init: RequestInit) => {
    if (!walletAddress) throw new Error('Connect wallet before live Tempo MPP payments.')
    if (!window.ethereum) throw new Error('Wallet not found.')
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

    try {
      return await makeMppx('push').fetch(url, init)
    } catch (pushErr) {
      const isMetaMask = Boolean(window.ethereum?.isMetaMask)
      if (isMetaMask) throw pushErr
      return await makeMppx('pull').fetch(url, init)
    }
  }

  const connectWallet = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts?.length) throw new Error('No wallet account returned.')
      setWalletAddress(accounts[0])
      await ensureSelectedWalletNetwork()
      pushLog(`Wallet connected; switched to ${networkLabel}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Wallet: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const runTransaction = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      const kind = activeFlow
      if (paymentMode === 'live' && !walletAddress) {
        throw new Error('Connect wallet before live payments.')
      }

      const payload = buildFlowPayload(kind, network)
      const jsonInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }

      if (kind === 'bot-action') {
        let botRes: Response
        if (paymentMode === 'live') {
          botRes = await liveMppFetch(`/api/dance-extras/live/bot-action/${network}`, jsonInit)
        } else {
          botRes = await fetch(MOCK_PATH[kind], jsonInit)
        }
        const { data, text } = await parseResponse(botRes)
        if (!botRes.ok) throw new Error(httpFailureMessage(botRes, text, data, 'Bot action failed'))
        setLastChainId(typeof data.chainId === 'number' ? data.chainId : null)
        const botReceipt = paymentMode === 'live' ? botRes.headers.get('payment-receipt') || '' : ''
        const botTx = extractHexHash(botReceipt)

        let mailRes: Response
        if (paymentMode === 'live') {
          mailRes = await liveMppFetch('/api/ops/agentmail/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inbox_id: AGENTMAIL_DEMO_INBOX_ID,
              to: 'ops@dancetech.finance',
              subject: `Ops Alert: ${data.actionType}`,
              text: `Event ${data.eventId} action ${data.actionType} executed at ${data.createdAt}.`,
              network,
            }),
          })
        } else {
          mailRes = await fetch('/api/ops/agentmail/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inbox_id: AGENTMAIL_DEMO_INBOX_ID,
              to: 'ops@dancetech.finance',
              subject: `Ops Alert: ${data.actionType}`,
              text: `Event ${data.eventId} action ${data.actionType} executed at ${data.createdAt}.`,
              network,
            }),
          })
        }
        const { data: mailData, text: mailText } = await parseResponse(mailRes)
        if (!mailRes.ok) throw new Error(httpFailureMessage(mailRes, mailText, mailData, 'AgentMail alert failed'))
        setSummary(
          `Bot + AgentMail (${data.network})${botTx ? ` · ${botTx.slice(0, 12)}…` : ''} [${paymentMode}]`,
        )
        setStatus('ok')
        pushLog(`OK bot-action @ ${network} (${paymentMode})`)
        return
      }

      let res: Response
      if (paymentMode === 'live') {
        res = await liveMppFetch(`/api/dance-extras/live/${kind}/${network}`, jsonInit)
      } else {
        res = await fetch(MOCK_PATH[kind], jsonInit)
      }
      const { data, text } = await parseResponse(res)
      if (!res.ok) throw new Error(httpFailureMessage(res, text, data, 'Request failed'))

      setLastChainId(typeof data.chainId === 'number' ? data.chainId : null)
      const receiptHeader = paymentMode === 'live' ? res.headers.get('payment-receipt') || '' : ''
      const txHint = extractHexHash(receiptHeader)

      switch (kind) {
        case 'judge-score':
          setSummary(
            `Score receipt: ${data.receipt?.externalId ?? 'ok'} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`,
          )
          break
        case 'cypher-micropot':
          setSummary(`Cypher total: ${data.total} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`)
          break
        case 'clip-sale':
          setSummary(`Clip sale: ${data.saleId} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`)
          break
        case 'reputation':
          setSummary(`Badge: ${data.type} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`)
          break
        case 'ai-usage':
          setSummary(`Usage event: ${data.id} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`)
          break
        case 'fan-pass':
          setSummary(`Pass: ${data.passId} (${data.network})${txHint ? ` · ${txHint.slice(0, 12)}…` : ''}`)
          break
        default:
          setSummary('—')
      }
      setStatus('ok')
      pushLog(`OK ${activeFlow} @ ${network} (${paymentMode})`)
    } catch (err) {
      const raw = getErrorMessage(err)
      const msg = paymentMode === 'live' ? mapLivePayError(raw) : raw
      setStatus('error')
      setError(msg)
      setSummary('—')
      pushLog(`Error: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const resetFlow = (key: CoreExtraFlowKey) => {
    setActiveFlow(key)
    setStatus('idle')
    setSummary('—')
    setError('')
    setLastChainId(null)
    pushLog(`Switched to ${coreExtraFlowCopy[key].title}`)
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Seven DanceTech flows</h1>
        <p>
          Judge scores, cypher micropot, clip sales, reputation, studio AI usage, ops bot (+ AgentMail), and fan
          battle pass — same backend scaffolds as the hub, with explicit <strong>Tempo testnet / mainnet</strong>{' '}
          selection on every API call (responses include <code>network</code> + <code>chainId</code>). Use{' '}
          <strong>Live Tempo MPP</strong> for real wallet-paid flows (same pattern as Beats). For Battle, Coaching,
          and Beat licensing, use <code>/battle</code>, <code>/coaching</code>, and <code>/beats</code>.
        </p>
        <p>
          <a href="/">← Hub</a>
        </p>
      </header>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Tempo network</h2>
        <div className="actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <button
            type="button"
            className={network === 'testnet' ? undefined : 'secondary'}
            onClick={() => setNetwork('testnet')}
            disabled={loading}
          >
            Testnet (42431)
          </button>
          <button
            type="button"
            className={network === 'mainnet' ? undefined : 'secondary'}
            onClick={() => setNetwork('mainnet')}
            disabled={loading}
          >
            Mainnet (4217)
          </button>
        </div>
        <p className="intent" style={{ marginBottom: 0 }}>
          Selected: <strong>{networkLabel}</strong>
          {lastChainId != null ? (
            <>
              {' '}
              · Last API <code>chainId</code>: <strong>{lastChainId}</strong>
            </>
          ) : null}
        </p>
        <div className="actions" style={{ marginTop: '0.75rem' }}>
          <button type="button" className="secondary" onClick={connectWallet} disabled={loading}>
            {walletAddress ? `Wallet: ${walletAddress.slice(0, 8)}…` : 'Connect wallet (optional)'}
          </button>
          {walletAddress ? (
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await ensureSelectedWalletNetwork()
                  pushLog(`Wallet switched to ${networkLabel}`)
                } catch (e) {
                  setError(getErrorMessage(e))
                }
              }}
              disabled={loading}
            >
              Match wallet to selection
            </button>
          ) : null}
        </div>
        <div className="actions" style={{ marginTop: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="intent" style={{ alignSelf: 'center', marginRight: '0.25rem' }}>
            Payment:
          </span>
          <button
            type="button"
            className={paymentMode === 'simulate' ? undefined : 'secondary'}
            onClick={() => setPaymentMode('simulate')}
            disabled={loading}
          >
            Simulate (no chain pay)
          </button>
          <button
            type="button"
            className={paymentMode === 'live' ? undefined : 'secondary'}
            onClick={() => setPaymentMode('live')}
            disabled={loading}
          >
            Live Tempo MPP
          </button>
        </div>
        {paymentMode === 'live' ? (
          <p className="intent" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
            Live mode uses <code>/api/dance-extras/live/&lt;flow&gt;/&lt;network&gt;</code> — connect wallet and approve
            on-chain payment (requires <code>MPP_SECRET_KEY</code> + <code>MPP_RECIPIENT</code> on the server).
          </p>
        ) : null}
      </section>

      <section className="grid">
        <article className="card">
          <h2>Flows</h2>
          <div className="extra-action-grid">
            {CORE_EXTRA_FLOW_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                className={activeFlow === key ? 'active' : ''}
                onClick={() => resetFlow(key)}
              >
                {coreExtraFlowCopy[key].title}
              </button>
            ))}
          </div>
          <h3 style={{ marginTop: '1rem' }}>{flow.title}</h3>
          <p className="intent">
            Flow key <code>{activeFlow}</code>
            {paymentMode === 'live' ? (
              <>
                {' '}
                · live <code>POST /api/dance-extras/live/{activeFlow}/{network}</code>
              </>
            ) : null}
          </p>
          <p className="intent">
            Payment intent: <strong>{flow.intent}</strong> · <code>{flow.endpoint}</code>
          </p>
          <p>{flow.subtitle}</p>
          <p className="intent" style={{ marginBottom: 0 }}>
            {paymentMode === 'live' ? (
              <>
                <strong>One click</strong> charges via Tempo MPP (wallet prompt) and completes the flow on the server.
                {activeFlow === 'bot-action'
                  ? ` Includes a second MPP charge for AgentMail send (from inbox ${AGENTMAIL_DEMO_INBOX_ID}) when AGENTMAIL_API_KEY is set.`
                  : null}
              </>
            ) : (
              <>
                <strong>One click</strong> calls the mock API with demo data — no on-chain payment.
              </>
            )}
          </p>
          <details style={{ marginTop: '0.75rem' }}>
            <summary style={{ cursor: 'pointer' }}>Typical integration steps (reference)</summary>
            <ol style={{ marginTop: '0.5rem' }}>
              {flow.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </details>
          <div className="actions" style={{ marginTop: '1rem' }}>
            <button type="button" onClick={runTransaction} disabled={loading}>
              {loading
                ? paymentMode === 'live'
                  ? 'Confirm in wallet…'
                  : 'Calling API…'
                : paymentMode === 'live'
                  ? 'Pay & run (Tempo MPP)'
                  : 'Run demo transaction'}
            </button>
            <button type="button" className="secondary" onClick={() => resetFlow(activeFlow)} disabled={loading}>
              Reset telemetry
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Network (UI)</span>
              <strong>{network}</strong>
            </li>
            <li>
              <span>Status</span>
              <strong className={status === 'error' ? 'error' : status === 'ok' ? 'ok' : ''}>{status}</strong>
            </li>
            <li>
              <span>Summary</span>
              <strong>{summary}</strong>
            </li>
          </ul>
          {error ? <p className="error">{error}</p> : null}
          <h4>Log</h4>
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>
                <code>{entry}</code>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  )
}
