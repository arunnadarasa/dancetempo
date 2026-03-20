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
import './App.css'
import { addTxHistory, clearTxHistory, explorerTxUrl, listTxHistory } from './txHistory'

type Network = 'testnet' | 'mainnet'
declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

const webhookEvents = [
  'payment.intent.created',
  'payment.finalized',
  'battle.results.finalized',
  'payout.executed',
]

const tempoTestnetChain = tempoModerato.extend({
  nativeCurrency: {
    name: 'USD',
    symbol: 'USD',
    decimals: 18,
  },
  // Use explicit fee token to match Tempo transaction semantics.
  feeToken: '0x20c0000000000000000000000000000000000001',
  // Increasing blockTime increases viem sendCallsSync wait timeout.
  blockTime: 30_000,
})

const tempoMainnetChain = tempoMainnet.extend({
  nativeCurrency: {
    name: 'USD',
    symbol: 'USD',
    decimals: 18,
  },
  feeToken: '0x20c000000000000000000000b9537d11c60e8b50',
  blockTime: 30_000,
})

const toHexChainId = (id: number) => `0x${id.toString(16)}`

const addTempoNetwork = async (network: Network) => {
  if (!window.ethereum) return
  const chain = network === 'testnet' ? tempoTestnetChain : tempoMainnetChain
  const rpcUrl = chain.rpcUrls.default.http[0]
  await window.ethereum.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: toHexChainId(chain.id),
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [rpcUrl],
        blockExplorerUrls: chain.blockExplorers?.default?.url
          ? [chain.blockExplorers.default.url]
          : [],
      },
    ],
  })
}

const switchWalletNetwork = async (network: Network) => {
  if (!window.ethereum) throw new Error('Injected wallet provider is not available.')
  const chainId = network === 'testnet' ? 42431 : 4217
  const chainIdHex = toHexChainId(chainId)
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    })
  } catch (err: any) {
    // 4902 is standard "unknown chain" for add-then-switch flow.
    if (err?.code === 4902) {
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

const mapLivePayError = (message: string) => {
  const lower = message.toLowerCase()
  if (lower.includes('timed out while waiting for call bundle id')) {
    return 'MetaMask submitted the call bundle but confirmation polling timed out. Check wallet activity and Tempo explorer, then retry after the transaction is mined.'
  }
  if (
    lower.includes('metamask') &&
    (lower.includes('wallet_sendcalls') || lower.includes('eth_signtransaction'))
  ) {
    return 'MetaMask does not expose the transaction method required for this MPP challenge flow on this network. Use Tempo Wallet for live MPP payment, or keep using simulated payment mode.'
  }
  if (lower.includes("eth_signtransaction") && lower.includes('not supported')) {
    return 'Wallet does not support eth_signTransaction (pull mode). The app will try push mode first; if both push and pull fail, wallet capability limits are blocking this flow.'
  }
  if (lower.includes("wallet_sendcalls") && lower.includes('not allowed')) {
    return 'Wallet does not allow wallet_sendCalls (push mode).'
  }
  if (lower.includes('insufficientbalance') || lower.includes('amount exceeds balance')) {
    return 'Insufficient token balance for this payment. Fund the connected wallet for the selected network and retry.'
  }
  if (lower.includes('internal json-rpc error')) {
    return 'Wallet RPC rejected the transaction simulation. Confirm wallet network matches selection and that both payment token + gas fee token are funded.'
  }
  if (lower.includes('user rejected') || lower.includes('rejected the request')) {
    return 'Transaction approval was rejected in wallet.'
  }
  if (lower.includes('chain') && lower.includes('mismatch')) {
    return 'Wallet network does not match selected network. Switch wallet network and retry.'
  }
  return message
}

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>
    const direct =
      (typeof anyErr.message === 'string' && anyErr.message) ||
      (typeof anyErr.shortMessage === 'string' && anyErr.shortMessage) ||
      (typeof anyErr.details === 'string' && anyErr.details) ||
      (typeof anyErr.reason === 'string' && anyErr.reason)
    if (direct) return direct
    if (anyErr.cause && typeof anyErr.cause === 'object') {
      const cause = anyErr.cause as Record<string, unknown>
      const causeMessage =
        (typeof cause.message === 'string' && cause.message) ||
        (typeof cause.shortMessage === 'string' && cause.shortMessage) ||
        (typeof cause.details === 'string' && cause.details)
      if (causeMessage) return causeMessage
    }
    try {
      return JSON.stringify(anyErr)
    } catch {
      return 'Unknown error'
    }
  }
  return 'Unknown error'
}

const extractHexHash = (value: string) => {
  const prefixed = value.match(/0x[a-fA-F0-9]{64}/)
  if (prefixed) return prefixed[0]
  const bare = value.match(/\b[a-fA-F0-9]{64}\b/)
  return bare ? `0x${bare[0]}` : ''
}

const shortHash = (hash: string) => {
  if (!hash || hash.length < 14) return hash
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`
}

const shortBlob = (value: string, keep = 84) => {
  if (!value) return value
  if (value.length <= keep) return value
  return `${value.slice(0, keep)}...`
}

export default function BattleApp() {
  const [network, setNetwork] = useState<Network>('testnet')
  const [battleId, setBattleId] = useState('battle_demo')
  const [dancerId, setDancerId] = useState('dancer_1')
  const [entryFee, setEntryFee] = useState('12.00')
  const [winnerId, setWinnerId] = useState('dancer_1')
  const [winnerAmount, setWinnerAmount] = useState('30.00')

  const [intentId, setIntentId] = useState('')
  const [intentStatus, setIntentStatus] =
    useState<'idle' | 'requires_payment' | 'pending_confirmation' | 'payment_finalized'>('idle')
  const [chainId, setChainId] = useState<number | null>(null)
  const [paymentRequest, setPaymentRequest] = useState('')
  const [payoutCount, setPayoutCount] = useState(0)
  const [payoutExecutedAt, setPayoutExecutedAt] = useState('')
  const [recoveryTxHash, setRecoveryTxHash] = useState('')
  const [detectedTxHash, setDetectedTxHash] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [liveReceipt, setLiveReceipt] = useState('')
  const [showFullPaymentRequest, setShowFullPaymentRequest] = useState(false)
  const [showFullLiveReceipt, setShowFullLiveReceipt] = useState(false)
  const [txHistory, setTxHistory] = useState(() => listTxHistory())
  const [manualTxHash, setManualTxHash] = useState('')
  const [log, setLog] = useState<string[]>([
    'Battle frontend initialized. Pick network and run through actions.',
  ])

  const networkLabel =
    network === 'testnet' ? 'Tempo Testnet (42431)' : 'Tempo Mainnet (4217)'
  const expectedChain = network === 'testnet' ? 42431 : 4217
  const statusLabel = useMemo(() => {
    if (intentStatus === 'idle') return 'draft'
    return intentStatus
  }, [intentStatus])
  const txExplorerBase =
    network === 'testnet' ? 'https://explore.testnet.tempo.xyz/tx/' : 'https://explore.tempo.xyz/tx/'
  const detectedTxHref = detectedTxHash ? `${txExplorerBase}${detectedTxHash}` : ''
  const recoveryTxHref =
    recoveryTxHash && recoveryTxHash.startsWith('0x') ? `${txExplorerBase}${recoveryTxHash}` : ''

  const pushLog = (entry: string) => {
    setLog((prev) => [entry, ...prev].slice(0, 10))
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

  const refreshTxHistory = () => setTxHistory(listTxHistory())

  const rememberTx = (hash: string) => {
    addTxHistory({ hash, network, flow: 'battle' })
    refreshTxHistory()
  }

  const addManualTx = () => {
    const tx = manualTxHash.trim()
    if (!tx) return
    rememberTx(tx)
    setManualTxHash('')
    pushLog('Manual transaction added to history.')
  }

  const confirmAndRecoverLivePayment = async (txHash: string) => {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const res = await fetch('/api/battle/live/confirm-and-recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId,
          txHash,
          battleId,
          dancerId,
          amountDisplay: entryFee,
          network,
        }),
      })
      const { data } = await parseResponse(res)
      if (res.ok) {
        setIntentStatus('payment_finalized')
        if (typeof data?.intentId === 'string' && data.intentId.length > 0) {
          setIntentId(data.intentId)
        }
        if (typeof data?.chainId === 'number') setChainId(data.chainId)
        setLiveReceipt(data?.paymentReceipt || '')
        setError('')
        pushLog(`Auto-confirmed and recovered tx ${txHash.slice(0, 12)}...`)
        return true
      }
      const waitMs = 1500 * attempt
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    return false
  }

  const createEntryIntent = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/battle/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ battleId, dancerId, amountDisplay: entryFee, network }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Create intent failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      setIntentId(data.intentId)
      setIntentStatus(data.status)
      setPaymentRequest(data.paymentRequest ?? '')
      setChainId(data.chainId ?? null)
      pushLog(`Entry intent created (${networkLabel}).`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Create entry intent failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const connectWallet = async () => {
    setError('')
    try {
      const eth = window.ethereum
      if (!eth) {
        throw new Error('No injected wallet found. Install or unlock a wallet extension.')
      }
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts || accounts.length === 0) {
        throw new Error('No wallet account available.')
      }
      setWalletAddress(accounts[0])
      pushLog(`Wallet connected: ${accounts[0]}`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Wallet connection failed: ${message}`)
    }
  }

  const ensureSelectedWalletNetwork = async () => {
    if (!window.ethereum) {
      throw new Error('Injected wallet provider is not available.')
    }
    const selectedChainId = network === 'testnet' ? 42431 : 4217
    const currentChainHex = (await window.ethereum.request({
      method: 'eth_chainId',
    })) as string
    const currentChainId = Number.parseInt(currentChainHex, 16)
    if (currentChainId !== selectedChainId) {
      await switchWalletNetwork(network)
      const recheckHex = (await window.ethereum.request({
        method: 'eth_chainId',
      })) as string
      const recheckId = Number.parseInt(recheckHex, 16)
      if (recheckId !== selectedChainId) {
        throw new Error(
          `Chain mismatch: wallet is ${recheckId}, selected network expects ${selectedChainId}.`,
        )
      }
    }
  }

  const payEntryOnchain = async () => {
    setLoading(true)
    setError('')
    setLiveReceipt('')
    try {
      if (!walletAddress) {
        throw new Error('Connect wallet first.')
      }
      if (!window.ethereum) {
        throw new Error('Injected wallet provider is not available.')
      }
      let currentIntentId = intentId
      if (!currentIntentId) {
        const seedRes = await fetch('/api/battle/entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ battleId, dancerId, amountDisplay: entryFee, network }),
        })
        const { data: seedData, text: seedText } = await parseResponse(seedRes)
        if (!seedRes.ok) {
          throw new Error(
            seedData?.error ||
              seedData?.details ||
              `Create intent failed (${seedRes.status}) ${seedText.slice(0, 80)}`,
          )
        }
        currentIntentId = seedData.intentId
        setIntentId(seedData.intentId)
        setIntentStatus(seedData.status)
        setPaymentRequest(seedData.paymentRequest ?? '')
        setChainId(seedData.chainId ?? null)
        pushLog(`Entry intent auto-created (${networkLabel}) for live payment.`)
      }

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

      const url = `/api/battle/live/entry/${network}`
      const requestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battleId,
          dancerId,
          amountDisplay: entryFee,
        }),
      } satisfies RequestInit

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

      const isMetaMask = Boolean(window.ethereum?.isMetaMask)

      // Try push first (no eth_signTransaction). Fallback to pull if needed.
      // MetaMask often rejects eth_signTransaction, so avoid pull there.
      let res: Response
      try {
        res = await makeMppx('push').fetch(url, requestInit)
        pushLog('Live pay strategy: push mode.')
      } catch (pushErr) {
        const pushMessage = getErrorMessage(pushErr)
        pushLog(`Push mode failed: ${pushMessage}`)
        if (isMetaMask) {
          throw new Error(`MetaMask push failed: ${pushMessage}`)
        }
        try {
          res = await makeMppx('pull').fetch(url, requestInit)
          pushLog('Live pay strategy fallback: pull mode.')
        } catch (pullErr) {
          const pullMessage = getErrorMessage(pullErr)
          pushLog(`Pull mode failed: ${pullMessage}`)
          throw new Error(`MPP payment failed. push: ${pushMessage} | pull: ${pullMessage}`)
        }
      }

      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Live onchain payment failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      const receiptHeader = res.headers.get('payment-receipt') || ''
      setIntentStatus('payment_finalized')
      setChainId(network === 'testnet' ? 42431 : 4217)
      setLiveReceipt(receiptHeader)
      const receiptTx = extractHexHash(receiptHeader)
      if (receiptTx) {
        setDetectedTxHash(receiptTx)
        setRecoveryTxHash((prev) => prev || receiptTx)
        rememberTx(receiptTx)
      }
      pushLog(`Live onchain payment completed on ${networkLabel}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      const detected = extractHexHash(message)
      if (detected) {
        setDetectedTxHash(detected)
        setRecoveryTxHash((prev) => prev || detected)
        setIntentStatus('pending_confirmation')
        rememberTx(detected)
        pushLog(`Pending confirmation for tx ${detected.slice(0, 12)}...`)
        confirmAndRecoverLivePayment(detected).catch(() => {})
      }
      const mapped = mapLivePayError(message)
      setError(mapped)
      pushLog(`Live payment failed: ${mapped}`)
    } finally {
      setLoading(false)
    }
  }

  const recoverLivePayment = async (hashOverride?: string) => {
    setLoading(true)
    setError('')
    try {
      if (!intentId) {
        throw new Error('Create entry intent first so recovery can target an intent.')
      }
      const txHash = (hashOverride || recoveryTxHash).trim()
      if (!txHash.startsWith('0x')) {
        throw new Error('Enter a valid 0x-prefixed transaction hash.')
      }
      const res = await fetch('/api/battle/live/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId,
          txHash,
          battleId,
          dancerId,
          amountDisplay: entryFee,
          network,
        }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error || data?.details || `Recover payment failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      setIntentStatus(data.status)
      if (typeof data.intentId === 'string' && data.intentId.length > 0) {
        setIntentId(data.intentId)
      }
      if (typeof data.chainId === 'number') setChainId(data.chainId)
      setLiveReceipt(data.paymentReceipt || '')
      setRecoveryTxHash(txHash)
      setDetectedTxHash(txHash)
      rememberTx(txHash)
      pushLog(`Recovered live payment from tx ${txHash.slice(0, 12)}...`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Recover live payment failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const simulatePayment = async () => {
    if (!intentId) {
      setError('Create entry intent first.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/battle/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battleId,
          dancerId,
          intentId,
          simulatePayment: true,
          network,
        }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Simulate payment failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      setIntentStatus(data.status)
      pushLog('Payment simulated and finalized.')
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Simulate payment failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const finalizeResults = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/battle/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battleId,
          winners: [{ dancerId: winnerId, amountDisplay: winnerAmount }],
        }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Finalize results failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      pushLog(`Results finalized for ${battleId}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Finalize results failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const executePayout = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/payout/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ battleId, network }),
      })
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Execute payout failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      setPayoutCount(Array.isArray(data.payouts) ? data.payouts.length : 0)
      setPayoutExecutedAt(data.executedAt || '')
      pushLog(
        `Payout executed with ${
          Array.isArray(data.payouts) ? data.payouts.length : 0
        } settlements.`,
      )
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Execute payout failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const fetchPayoutExecution = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/payout/${battleId}`)
      const { data, text } = await parseResponse(res)
      if (!res.ok) {
        throw new Error(
          data?.error ||
            data?.details ||
            `Fetch payout failed (${res.status}) ${text.slice(0, 80)}`,
        )
      }
      setPayoutCount(Array.isArray(data.payouts) ? data.payouts.length : 0)
      setPayoutExecutedAt(data.executedAt || '')
      pushLog(`Fetched payout execution for ${battleId}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Fetch payout failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const copyText = async (value: string, label: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      pushLog(`${label} copied.`)
    } catch {
      pushLog(`Failed to copy ${label.toLowerCase()}.`)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Battle Entry + Auto Payout</h1>
        <p>Dedicated frontend for Tempo + MPP battle registration and payout testing.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Battle Controls</h2>
          <div className="field-grid">
            <label>
              Network
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value as Network)}
                disabled={loading}
              >
                <option value="testnet">Tempo Testnet</option>
                <option value="mainnet">Tempo Mainnet</option>
              </select>
            </label>
            <label>
              Battle ID
              <input
                value={battleId}
                onChange={(e) => setBattleId(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Dancer ID
              <input
                value={dancerId}
                onChange={(e) => setDancerId(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Entry Fee
              <input
                value={entryFee}
                onChange={(e) => setEntryFee(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Winner ID
              <input
                value={winnerId}
                onChange={(e) => setWinnerId(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Winner Amount
              <input
                value={winnerAmount}
                onChange={(e) => setWinnerAmount(e.target.value)}
                disabled={loading}
              />
            </label>
          </div>

          <div className="actions">
            <button className="secondary" onClick={connectWallet} disabled={loading}>
              {walletAddress ? 'Wallet Connected' : 'Connect Wallet'}
            </button>
            <button onClick={payEntryOnchain} disabled={loading || !walletAddress}>
              Live Pay Onchain
            </button>
          </div>
          {intentStatus !== 'payment_finalized' ? (
            <div className="actions">
              <input
                placeholder="0x tx hash for recovery"
                value={recoveryTxHash}
                onChange={(e) => setRecoveryTxHash(e.target.value)}
                disabled={loading}
              />
              <button
                className="secondary"
                onClick={() => recoverLivePayment()}
                disabled={loading || !intentId}
              >
                Recover Live Payment
              </button>
              <button
                className="secondary"
                onClick={() => recoverLivePayment(detectedTxHash)}
                disabled={loading || !intentId || !detectedTxHash}
              >
                One-Click Recover
              </button>
            </div>
          ) : null}
          {recoveryTxHref ? (
            <p>
              Recovery tx:{' '}
              <a href={recoveryTxHref} target="_blank" rel="noreferrer">
                {shortHash(recoveryTxHash)}
              </a>
            </p>
          ) : null}
          <div className="actions">
            <button onClick={createEntryIntent} disabled={loading}>
              1. Create Entry Intent
            </button>
            <button onClick={simulatePayment} disabled={loading || !intentId}>
              2. Simulate Payment
            </button>
          </div>
          <div className="actions">
            <button onClick={finalizeResults} disabled={loading}>
              3. Finalize Results
            </button>
            <button onClick={executePayout} disabled={loading}>
              4. Execute Payout
            </button>
            <button className="secondary" onClick={fetchPayoutExecution} disabled={loading}>
              Fetch Payout
            </button>
          </div>
        </article>

        <article className="card">
          <h3>Live Demo Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{statusLabel}</strong>
            </li>
            <li>
              <span>Network</span>
              <strong>{networkLabel}</strong>
            </li>
            <li>
              <span>Expected Chain</span>
              <strong>{expectedChain}</strong>
            </li>
            <li>
              <span>API Chain</span>
              <strong>{chainId ?? '—'}</strong>
            </li>
            <li>
              <span>Intent ID</span>
              <strong>{intentId || '—'}</strong>
            </li>
            <li>
              <span>Payouts Settled</span>
              <strong>{payoutCount}</strong>
            </li>
            <li>
              <span>Wallet</span>
              <strong>{walletAddress || 'not_connected'}</strong>
            </li>
            <li>
              <span>Detected Tx</span>
              <strong>
                {detectedTxHref ? (
                  <a href={detectedTxHref} target="_blank" rel="noreferrer">
                    {shortHash(detectedTxHash)}
                  </a>
                ) : (
                  '—'
                )}
              </strong>
            </li>
          </ul>
          {error ? <p className="error">{error}</p> : null}
          <h4>Webhook events</h4>
          <div className="chips">
            {webhookEvents.map((event) => (
              <code key={event}>{event}</code>
            ))}
          </div>
          <h4>Latest actions</h4>
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card api">
        <h3>Transaction History</h3>
        <p>Recent relevant transactions across testnet and mainnet.</p>
        <div className="actions">
          <input
            placeholder="Paste tx hash from explorer"
            value={manualTxHash}
            onChange={(e) => setManualTxHash(e.target.value)}
            disabled={loading}
          />
          <button className="secondary" onClick={addManualTx} disabled={!manualTxHash.trim()}>
            Add Transaction
          </button>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => {
              clearTxHistory()
              refreshTxHistory()
              pushLog('Transaction history cleared.')
            }}
            disabled={txHistory.length === 0}
          >
            Clear History
          </button>
        </div>
        <ul className="log">
          {txHistory.length === 0 ? (
            <li>No saved transactions yet.</li>
          ) : (
            txHistory.map((tx) => (
              <li key={`${tx.network}:${tx.hash}`}>
                <strong>{tx.flow}</strong> - {tx.network} -{' '}
                <a href={explorerTxUrl(tx.network, tx.hash)} target="_blank" rel="noreferrer">
                  {shortHash(tx.hash)}
                </a>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="card api">
        <h3>Battle API Contract</h3>
        <div className="api-list">
          <code>POST /api/battle/entry</code>
          <code>POST /api/battle/live/confirm-and-recover</code>
          <code>POST /api/battle/live/recover</code>
          <code>POST /api/battle/result</code>
          <code>POST /api/payout/execute</code>
          <code>GET /api/payout/:battleId</code>
        </div>
      </section>

      <section className="card api">
        <h3>Encoded Payment Request</h3>
        <p>Base64url-encoded MPP PaymentRequest generated for the selected network.</p>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => setShowFullPaymentRequest((v) => !v)}
            disabled={!paymentRequest}
          >
            {showFullPaymentRequest ? 'Show Short' : 'Show Full'}
          </button>
          <button
            className="secondary"
            onClick={() => copyText(paymentRequest, 'Payment request')}
            disabled={!paymentRequest}
          >
            Copy
          </button>
        </div>
        <pre className="ai-output">
          {paymentRequest
            ? showFullPaymentRequest
              ? paymentRequest
              : shortBlob(paymentRequest)
            : 'No intent created yet.'}
        </pre>
        <p>Live Payment-Receipt header:</p>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => setShowFullLiveReceipt((v) => !v)}
            disabled={!liveReceipt}
          >
            {showFullLiveReceipt ? 'Show Short' : 'Show Full'}
          </button>
          <button
            className="secondary"
            onClick={() => copyText(liveReceipt, 'Live receipt')}
            disabled={!liveReceipt}
          >
            Copy
          </button>
        </div>
        <pre className="ai-output">
          {liveReceipt
            ? showFullLiveReceipt
              ? liveReceipt
              : shortBlob(liveReceipt)
            : 'No live payment receipt yet.'}
        </pre>
        {payoutExecutedAt ? (
          <p>
            Last payout execution: <code>{payoutExecutedAt}</code>
          </p>
        ) : null}
      </section>
    </main>
  )
}
