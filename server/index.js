import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import { Receipt } from 'mppx'
import { Mppx as MppxServer, tempo as tempoServer } from 'mppx/server'
import { createPublicClient, http } from 'viem'
import { tempo as tempoMainnetChain, tempoModerato as tempoTestnetChain } from 'viem/chains'
import {
  createBattleEntryIntent,
  createBeatLicenseIntent,
  createMockReceipt,
  endCoachingSession,
  executeBattlePayout,
  finalizeBattleResults,
  getBattlePayoutExecution,
  getCoachingReceipt,
  getVirtualDebitCard,
  grantBeatLicense,
  recoverBattleEntryPayment,
  startCoachingSession,
  tickCoachingSession,
  createVirtualDebitCard,
  verifyBattleEntryPayment,
} from './payments.js'

const app = express()
const port = Number(process.env.PORT || 8787)

const openAiMppUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})
const mppSecretKey =
  process.env.MPP_SECRET_KEY || 'dev_only_replace_with_real_secret_key'

const liveMppByNetwork = {
  testnet: MppxServer.create({
    methods: [
      tempoServer({
        testnet: true,
        recipient: process.env.MPP_RECIPIENT,
      }),
    ],
    secretKey: mppSecretKey,
  }),
  mainnet: MppxServer.create({
    methods: [
      tempoServer({
        testnet: false,
        recipient: process.env.MPP_RECIPIENT,
      }),
    ],
    secretKey: mppSecretKey,
  }),
}

const judgeScores = []
const cypherMicropots = new Map()
const clipSales = new Map()
const reputationAttestations = []
const studioUsageEvents = []
const botActions = []
const fanPasses = new Map()
const tip20Launches = []
const coachingLiveRecoveryByTx = new Map()
const beatsLiveRecoveryByTx = new Map()
// Laso card x402 wrapper returns bearer tokens (id_token/refresh_token) with the card order.
// We need them to poll /get-card-data for the real card details later.
const lasoCardAuthById = new Map()
// When Laso rejects (e.g., geo restriction like "US only"), we fall back to the local mock card.
const lasoCardDemoReasonById = new Map()

const randomHexAddress = () => {
  const hex = Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `0x${hex}`
}

const publicClientByNetwork = {
  testnet: createPublicClient({
    chain: tempoTestnetChain,
    transport: http(tempoTestnetChain.rpcUrls.default.http[0]),
  }),
  mainnet: createPublicClient({
    chain: tempoMainnetChain,
    transport: http(tempoMainnetChain.rpcUrls.default.http[0]),
  }),
}

app.use(express.json({ limit: '1mb' }))

function toFetchRequest(req) {
  const origin = `${req.protocol}://${req.get('host')}`
  const url = new URL(req.originalUrl, origin).toString()
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : JSON.stringify(req.body ?? {})
  return new Request(url, { method: req.method, headers, body })
}

/**
 * Forward a fetch Response to Express. We buffer the body with `res.send()`, so we must not
 * forward `Content-Length` + `Transfer-Encoding` from upstream — that pair is illegal in HTTP/1.1
 * and breaks Node's client (e.g. Vite's proxy to this server): "Parse Error: Content-Length can't
 * be present with Transfer-Encoding".
 */
async function sendFetchResponse(res, fetchResponse) {
  res.status(fetchResponse.status)
  fetchResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (
      lower === 'transfer-encoding' ||
      lower === 'content-length' ||
      lower === 'content-encoding' ||
      lower === 'connection' ||
      lower === 'keep-alive'
    ) {
      return
    }
    res.setHeader(key, value)
  })
  const text = await fetchResponse.text()
  res.send(text)
}

function getForwardAuthHeaders(req) {
  const headers = {}
  const authorization = req.get('authorization')
  const payment = req.get('payment')
  const paymentReceipt = req.get('payment-receipt')
  const signInWithX = req.get('sign-in-with-x')
  if (typeof authorization === 'string' && authorization.length > 0) {
    headers.Authorization = authorization
  }
  if (typeof payment === 'string' && payment.length > 0) {
    headers.Payment = payment
  }
  if (typeof paymentReceipt === 'string' && paymentReceipt.length > 0) {
    headers['Payment-Receipt'] = paymentReceipt
  }
  // StableSocial GET /api/jobs uses x402 SIWX (not payment) when accepts is empty.
  if (typeof signInWithX === 'string' && signInWithX.length > 0) {
    headers['sign-in-with-x'] = signInWithX
  }
  return headers
}

/** Tempo network selector from JSON body (same convention as battle/coaching/beats). */
function normalizeTempoNetworkFromBody(body) {
  const n = body?.network
  if (n === 'testnet' || n === 42431 || n === '42431') return { network: 'testnet', chainId: 42431 }
  if (n === 'mainnet' || n === 4217 || n === '4217') return { network: 'mainnet', chainId: 4217 }
  return { network: 'mainnet', chainId: 4217 }
}

/** Per-flow Tempo MPP charge (decimal string) for `/api/dance-extras/live/...` */
const DANCE_EXTRA_LIVE_AMOUNTS = {
  'judge-score': '0.01',
  'cypher-micropot': '0.02',
  'clip-sale': '0.05',
  reputation: '0.01',
  'ai-usage': '0.02',
  'bot-action': '0.03',
  'fan-pass': '0.04',
}

/**
 * Shared scaffold logic for the seven hub “extra” DanceTech flows (also used by live MPP route).
 * @returns {{ ok: true, status: number, result: object } | { ok: false, status: number, error: string }}
 */
function executeDanceExtraFlow(flowKey, body) {
  const tempoNet = normalizeTempoNetworkFromBody(body ?? {})
  switch (flowKey) {
    case 'judge-score': {
      const { battleId, roundId, judgeId, dancerId, score } = body ?? {}
      if (
        typeof battleId !== 'string' ||
        typeof roundId !== 'string' ||
        typeof judgeId !== 'string' ||
        typeof dancerId !== 'string' ||
        typeof score !== 'number'
      ) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid payload. Expected battleId, roundId, judgeId, dancerId (strings) and score (number).',
        }
      }
      const entry = {
        id: judgeScores.length + 1,
        battleId,
        roundId,
        judgeId,
        dancerId,
        score,
        createdAt: new Date().toISOString(),
      }
      judgeScores.push(entry)
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_score_${battleId}_${roundId}_${judgeId}_${dancerId}`,
        status: 'success',
        timestamp: entry.createdAt,
        externalId: `score_${entry.id}`,
      })
      return {
        ok: true,
        status: 201,
        result: { ...entry, receipt, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'cypher-micropot': {
      const { cypherId, dancerId, amount } = body ?? {}
      if (typeof cypherId !== 'string' || typeof dancerId !== 'string' || typeof amount !== 'number') {
        return {
          ok: false,
          status: 400,
          error: 'Invalid payload. Expected cypherId, dancerId (strings) and amount (number).',
        }
      }
      const pot =
        cypherMicropots.get(cypherId) ??
        {
          cypherId,
          total: 0,
          contributions: [],
        }
      const contribution = {
        dancerId,
        amount,
        contributedAt: new Date().toISOString(),
      }
      pot.total += amount
      pot.contributions.push(contribution)
      cypherMicropots.set(cypherId, pot)
      return {
        ok: true,
        status: 201,
        result: { ...pot, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'clip-sale': {
      const { clipId, buyerId, totalAmount, splits } = body ?? {}
      if (typeof clipId !== 'string' || typeof buyerId !== 'string') {
        return { ok: false, status: 400, error: 'Invalid payload. Expected clipId and buyerId as strings.' }
      }
      if (!Array.isArray(splits) || splits.length === 0) {
        return { ok: false, status: 400, error: 'Invalid payload. Expected non-empty splits[].' }
      }
      const saleId = `clip_${clipId}_${Date.now()}`
      const createdAt = new Date().toISOString()
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_clip_${clipId}_${saleId}`,
        status: 'success',
        timestamp: createdAt,
        externalId: saleId,
      })
      const sale = {
        saleId,
        clipId,
        buyerId,
        totalAmount,
        splits,
        createdAt,
        receipt,
      }
      clipSales.set(saleId, sale)
      return {
        ok: true,
        status: 201,
        result: { ...sale, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'reputation': {
      const { issuerId, dancerId, type, eventId } = body ?? {}
      if (typeof issuerId !== 'string' || typeof dancerId !== 'string' || typeof type !== 'string') {
        return {
          ok: false,
          status: 400,
          error: 'Invalid payload. Expected issuerId, dancerId, type as strings.',
        }
      }
      const attestation = {
        id: reputationAttestations.length + 1,
        issuerId,
        dancerId,
        type,
        eventId: typeof eventId === 'string' ? eventId : null,
        createdAt: new Date().toISOString(),
      }
      reputationAttestations.push(attestation)
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_reputation_${attestation.id}`,
        status: 'success',
        timestamp: attestation.createdAt,
        externalId: `reputation_${attestation.id}`,
      })
      return {
        ok: true,
        status: 201,
        result: { ...attestation, receipt, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'ai-usage': {
      const { studioId, toolId, units, mode } = body ?? {}
      if (typeof studioId !== 'string' || typeof toolId !== 'string' || typeof units !== 'number') {
        return {
          ok: false,
          status: 400,
          error: 'Invalid payload. Expected studioId, toolId (strings) and units (number).',
        }
      }
      const entry = {
        id: studioUsageEvents.length + 1,
        studioId,
        toolId,
        units,
        mode: mode === 'session' ? 'session' : 'charge',
        createdAt: new Date().toISOString(),
      }
      studioUsageEvents.push(entry)
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_ai_${entry.toolId}_${entry.id}`,
        status: 'success',
        timestamp: entry.createdAt,
        externalId: `ai_${entry.id}`,
      })
      return {
        ok: true,
        status: 201,
        result: { ...entry, receipt, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'bot-action': {
      const { eventId, actionType, payload } = body ?? {}
      if (typeof eventId !== 'string' || typeof actionType !== 'string') {
        return { ok: false, status: 400, error: 'Invalid payload. Expected eventId and actionType as strings.' }
      }
      const action = {
        id: botActions.length + 1,
        eventId,
        actionType,
        payload: payload ?? {},
        createdAt: new Date().toISOString(),
      }
      botActions.push(action)
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_bot_${eventId}_${action.id}`,
        status: 'success',
        timestamp: action.createdAt,
        externalId: `bot_${action.id}`,
      })
      return {
        ok: true,
        status: 201,
        result: { ...action, receipt, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    case 'fan-pass': {
      const { fanId, tier } = body ?? {}
      if (typeof fanId !== 'string') {
        return { ok: false, status: 400, error: 'Invalid payload. Expected fanId as a string.' }
      }
      const passId = `pass_${fanId}_${Date.now()}`
      const createdAt = new Date().toISOString()
      const receipt = Receipt.from({
        method: 'tempo',
        reference: `mock_pass_${fanId}_${passId}`,
        status: 'success',
        timestamp: createdAt,
        externalId: passId,
      })
      const pass = {
        passId,
        fanId,
        tier: typeof tier === 'string' ? tier : 'standard',
        createdAt,
        perks: ['livestream_chat', 'backstage_qna', 'discounts'],
        receipt,
      }
      fanPasses.set(passId, pass)
      return {
        ok: true,
        status: 201,
        result: { ...pass, network: tempoNet.network, chainId: tempoNet.chainId },
      }
    }
    default:
      return { ok: false, status: 400, error: 'Unknown dance extra flow.' }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'ai-proxy' })
})

// Tempo faucet proxy (testnet only).
// Avoids browser CORS issues by letting the Vite/Express server call the faucet API.
app.post('/api/tempo/faucet', async (req, res) => {
  const { address } = req.body ?? {}

  if (typeof address !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected address as a string.',
    })
  }

  const normalized = address.trim().toLowerCase()
  if (!normalized.startsWith('0x') || normalized.length < 4) {
    return res.status(400).json({
      error: 'Invalid address format. Expected 0x-prefixed address.',
    })
  }

  try {
    const upstream = await fetch('https://docs.tempo.xyz/api/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: normalized }),
    })

    const raw = await upstream.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Tempo faucet request failed.',
        upstreamStatus: upstream.status,
        details: data ?? raw,
      })
    }

    return res.status(upstream.status).json({
      ok: true,
      upstreamStatus: upstream.status,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Tempo faucet proxy failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/battle/live/entry/:network', async (req, res) => {
  const network = req.params.network === 'mainnet' ? 'mainnet' : 'testnet'
  const { battleId, dancerId, amountDisplay } = req.body ?? {}

  if (typeof battleId !== 'string' || typeof dancerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected battleId and dancerId as strings.',
    })
  }

  const mppx = liveMppByNetwork[network]
  const normalizedAmount = Number.parseFloat(amountDisplay || '12.00')
  const safeAmount = Number.isFinite(normalizedAmount) ? normalizedAmount : 12
  // mppx charge amount is token-denominated decimal string, not base units.
  const tokenAmount = safeAmount.toFixed(2)

  try {
    const handler = mppx.tempo.charge({
      amount: tokenAmount,
      description: `Battle ${battleId} entry for dancer ${dancerId}`,
      externalId: `battle_live_${battleId}_${dancerId}_${Date.now()}`,
    })
    const mppResponse = await handler(toFetchRequest(req))

    if (mppResponse.status === 402) {
      return sendFetchResponse(res, mppResponse.challenge)
    }

    const successResponse = mppResponse.withReceipt(
      Response.json({
        ok: true,
        network,
        battleId,
        dancerId,
        status: 'payment_finalized',
      }),
    )
    return sendFetchResponse(res, successResponse)
  } catch (error) {
    return res.status(400).json({
      error: 'Live onchain payment failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/battle/live/recover', (req, res) => {
  const { intentId, txHash, battleId, dancerId, amountDisplay, network } = req.body ?? {}
  if (typeof txHash !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected txHash as a string.',
    })
  }

  try {
    let targetIntentId = intentId
    if (typeof targetIntentId !== 'string' || targetIntentId.length === 0) {
      if (typeof battleId !== 'string' || typeof dancerId !== 'string') {
        return res.status(400).json({
          error:
            'Missing intentId. Provide intentId, or provide battleId + dancerId so server can recreate the intent.',
        })
      }
      const recreated = createBattleEntryIntent({ battleId, dancerId, amountDisplay, network })
      targetIntentId = recreated.intentId
    }

    let recovered
    try {
      recovered = recoverBattleEntryPayment({ intentId: targetIntentId, txHash })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (
        message.includes('Battle entry intent not found.') &&
        typeof battleId === 'string' &&
        typeof dancerId === 'string'
      ) {
        const recreated = createBattleEntryIntent({ battleId, dancerId, amountDisplay, network })
        recovered = recoverBattleEntryPayment({ intentId: recreated.intentId, txHash })
      } else {
        throw error
      }
    }
    return res.status(200).json({
      intentId: recovered.intentId,
      status: recovered.status,
      chainId: recovered.chainId,
      recovered: true,
      txHash,
      paymentReceipt: recovered.receipt ? Receipt.serialize(recovered.receipt) : null,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to recover live battle payment.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/battle/live/confirm-and-recover', async (req, res) => {
  const { intentId, txHash, battleId, dancerId, amountDisplay, network } = req.body ?? {}
  const resolvedNetwork = network === 'mainnet' ? 'mainnet' : 'testnet'
  if (typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return res.status(400).json({
      error: 'Invalid payload. Expected txHash as 0x-prefixed hash string.',
    })
  }

  try {
    const client = publicClientByNetwork[resolvedNetwork]
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return res.status(409).json({
        error: 'Transaction found but not successful.',
        txHash,
        onchainStatus: receipt.status,
      })
    }

    let targetIntentId = intentId
    if (typeof targetIntentId !== 'string' || targetIntentId.length === 0) {
      if (typeof battleId !== 'string' || typeof dancerId !== 'string') {
        return res.status(400).json({
          error:
            'Missing intentId. Provide intentId, or provide battleId + dancerId so server can recreate the intent.',
        })
      }
      const recreated = createBattleEntryIntent({
        battleId,
        dancerId,
        amountDisplay,
        network: resolvedNetwork,
      })
      targetIntentId = recreated.intentId
    }

    let recovered
    try {
      recovered = recoverBattleEntryPayment({ intentId: targetIntentId, txHash })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      if (
        message.includes('Battle entry intent not found.') &&
        typeof battleId === 'string' &&
        typeof dancerId === 'string'
      ) {
        const recreated = createBattleEntryIntent({
          battleId,
          dancerId,
          amountDisplay,
          network: resolvedNetwork,
        })
        recovered = recoverBattleEntryPayment({ intentId: recreated.intentId, txHash })
      } else {
        throw error
      }
    }

    return res.status(200).json({
      intentId: recovered.intentId,
      status: recovered.status,
      chainId: recovered.chainId,
      recovered: true,
      txHash,
      paymentReceipt: recovered.receipt ? Receipt.serialize(recovered.receipt) : null,
    })
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown error'
    return res.status(404).json({
      error: 'Transaction not confirmed yet.',
      details,
      txHash,
    })
  }
})

app.post('/api/battle/entry', (req, res) => {
  const { battleId, dancerId, amountDisplay, paymentReceipt, simulatePayment, intentId, network } =
    req.body ?? {}

  if (typeof battleId !== 'string' || typeof dancerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected battleId and dancerId as strings.',
    })
  }

  try {
    let intent
    if (typeof intentId === 'string' && intentId.length > 0) {
      intent = verifyBattleEntryPayment({
        intentId,
        paymentReceipt: null,
      })
      if (intent.battleId !== battleId || intent.dancerId !== dancerId) {
        return res.status(400).json({ error: 'intentId does not match battleId/dancerId.' })
      }
      const receiptHeader = req.get('payment-receipt')
      let suppliedReceipt = paymentReceipt || receiptHeader
      if (simulatePayment && intent.mode === 'mock' && !suppliedReceipt) {
        suppliedReceipt = createMockReceipt(intent)
      }
      if (typeof suppliedReceipt === 'string' && suppliedReceipt.length > 0) {
        intent = verifyBattleEntryPayment({ intentId, paymentReceipt: suppliedReceipt })
      }
    } else {
      intent = createBattleEntryIntent({ battleId, dancerId, amountDisplay, network })
      const receiptHeader = req.get('payment-receipt')
      let suppliedReceipt = paymentReceipt || receiptHeader
      if (simulatePayment && intent.mode === 'mock' && !suppliedReceipt) {
        suppliedReceipt = createMockReceipt(intent)
      }
      if (typeof suppliedReceipt === 'string' && suppliedReceipt.length > 0) {
        intent = verifyBattleEntryPayment({ intentId: intent.intentId, paymentReceipt: suppliedReceipt })
      }
    }

    return res.status(201).json({
      intentId: intent.intentId,
      status: intent.status,
      mode: intent.mode,
      testnet: intent.testnet,
      chainId: intent.chainId,
      paymentRequest: intent.requestEncoded,
      ...(intent.receipt ? { paymentReceipt: intent.receipt } : {}),
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to create or verify battle entry intent.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/battle/result', (req, res) => {
  const { battleId, winners } = req.body ?? {}
  const hasValidWinners =
    Array.isArray(winners) &&
    winners.length > 0 &&
    winners.every(
      (winner) =>
        winner &&
        typeof winner.dancerId === 'string' &&
        typeof winner.amountDisplay === 'string',
    )

  if (typeof battleId !== 'string' || !hasValidWinners) {
    return res.status(400).json({
      error:
        'Invalid payload. Expected battleId and winners[{ dancerId, amountDisplay }].',
    })
  }

  try {
    const result = finalizeBattleResults({ battleId, winners })
    return res.status(201).json({
      battleId: result.battleId,
      status: 'results_finalized',
      winners: result.winners,
      finalizedAt: result.finalizedAt,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to finalize battle results.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/payout/execute', (req, res) => {
  const { battleId, network } = req.body ?? {}

  if (typeof battleId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected battleId as a string.',
    })
  }

  try {
    const execution = executeBattlePayout({ battleId, network })
    return res.status(201).json({
      battleId: execution.battleId,
      mode: execution.mode,
      status: 'payout_executed',
      executedAt: execution.executedAt,
      payouts: execution.payouts,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to execute payout.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/payout/:battleId', (req, res) => {
  const execution = getBattlePayoutExecution(req.params.battleId)
  if (!execution) {
    return res.status(404).json({ error: 'Payout execution not found.' })
  }
  return res.json(execution)
})

app.post('/api/coaching/start', (req, res) => {
  const { coachId, dancerId, ratePerMinute } = req.body ?? {}

  if (typeof coachId !== 'string' || typeof dancerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected coachId and dancerId as strings.',
    })
  }

  const rate = Number(ratePerMinute ?? '2.5')
  if (!Number.isFinite(rate) || rate <= 0) {
    return res
      .status(400)
      .json({ error: 'Invalid ratePerMinute. Expected positive number.' })
  }

  try {
    const session = startCoachingSession({
      coachId,
      dancerId,
      ratePerMinute: rate,
    })
    return res.status(201).json({
      sessionId: session.id,
      status: session.status,
      ratePerMinute: session.ratePerMinute,
      createdAt: session.createdAt,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to start coaching session.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/coaching/live/start/:network', async (req, res) => {
  const network = req.params.network === 'mainnet' ? 'mainnet' : 'testnet'
  const { coachId, dancerId, ratePerMinute } = req.body ?? {}

  if (typeof coachId !== 'string' || typeof dancerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected coachId and dancerId as strings.',
    })
  }

  const rate = Number(ratePerMinute ?? '2.5')
  if (!Number.isFinite(rate) || rate <= 0) {
    return res.status(400).json({
      error: 'Invalid ratePerMinute. Expected positive number.',
    })
  }

  // Charge one minute upfront for live coaching session creation.
  const tokenAmount = rate.toFixed(2)
  const mppx = liveMppByNetwork[network]
  try {
    const handler = mppx.tempo.charge({
      amount: tokenAmount,
      description: `Coaching session start for ${dancerId} with ${coachId}`,
      externalId: `coaching_live_${coachId}_${dancerId}_${Date.now()}`,
    })
    const mppResponse = await handler(toFetchRequest(req))

    if (mppResponse.status === 402) {
      return sendFetchResponse(res, mppResponse.challenge)
    }

    const session = startCoachingSession({
      coachId,
      dancerId,
      ratePerMinute: rate,
    })

    const successResponse = mppResponse.withReceipt(
      Response.json({
        ok: true,
        network,
        sessionId: session.id,
        status: session.status,
        ratePerMinute: session.ratePerMinute,
        createdAt: session.createdAt,
      }),
    )
    return sendFetchResponse(res, successResponse)
  } catch (error) {
    return res.status(400).json({
      error: 'Live coaching session start failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/coaching/live/confirm-by-tx', async (req, res) => {
  const { txHash, coachId, dancerId, ratePerMinute, network } = req.body ?? {}
  const resolvedNetwork = network === 'mainnet' ? 'mainnet' : 'testnet'

  if (typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return res.status(400).json({
      error: 'Invalid payload. Expected txHash as 0x-prefixed hash string.',
    })
  }
  if (typeof coachId !== 'string' || typeof dancerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected coachId and dancerId as strings.',
    })
  }

  const rate = Number(ratePerMinute ?? '2.5')
  if (!Number.isFinite(rate) || rate <= 0) {
    return res.status(400).json({
      error: 'Invalid ratePerMinute. Expected positive number.',
    })
  }

  try {
    const client = publicClientByNetwork[resolvedNetwork]
    const onchainReceipt = await client.getTransactionReceipt({ hash: txHash })
    if (onchainReceipt.status !== 'success') {
      return res.status(409).json({
        error: 'Transaction found but not successful.',
        txHash,
        onchainStatus: onchainReceipt.status,
      })
    }

    const recovered = coachingLiveRecoveryByTx.get(txHash)
    if (recovered) {
      return res.status(200).json({ ...recovered, recovered: true, txHash })
    }

    const session = startCoachingSession({
      coachId,
      dancerId,
      ratePerMinute: rate,
    })
    const payload = {
      network: resolvedNetwork,
      sessionId: session.id,
      status: session.status,
      ratePerMinute: session.ratePerMinute,
      createdAt: session.createdAt,
    }
    coachingLiveRecoveryByTx.set(txHash, payload)
    return res.status(200).json({ ...payload, recovered: true, txHash })
  } catch (error) {
    return res.status(404).json({
      error: 'Transaction not confirmed yet.',
      details: error instanceof Error ? error.message : 'Unknown error',
      txHash,
    })
  }
})

app.post('/api/coaching/ping-usage', (req, res) => {
  const { sessionId, seconds } = req.body ?? {}
  const secondsNumber = Number(seconds ?? 30)

  if (typeof sessionId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected sessionId as a string.',
    })
  }

  if (!Number.isFinite(secondsNumber) || secondsNumber <= 0) {
    return res
      .status(400)
      .json({ error: 'Invalid seconds. Expected positive number.' })
  }

  try {
    const session = tickCoachingSession({ sessionId, seconds: secondsNumber })
    return res.json({
      sessionId: session.id,
      status: session.status,
      seconds: session.seconds,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to record coaching usage.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/coaching/end', (req, res) => {
  const { sessionId } = req.body ?? {}

  if (typeof sessionId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected sessionId as a string.',
    })
  }

  try {
    const session = endCoachingSession({ sessionId })
    return res.json({
      sessionId: session.id,
      status: session.status,
      minutes: session.minutes,
      amountDisplay: session.amountDisplay,
      receipt: session.receipt,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to end coaching session.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/coaching/:id/receipt', (req, res) => {
  const receipt = getCoachingReceipt(req.params.id)
  if (!receipt) {
    return res.status(404).json({ error: 'Receipt not found.' })
  }
  return res.json(receipt)
})

app.post('/api/beats/:id/license-intent', (req, res) => {
  const { id } = req.params
  const { consumerId, amountDisplay } = req.body ?? {}

  if (typeof consumerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected consumerId as a string.',
    })
  }

  try {
    const license = createBeatLicenseIntent({
      beatId: id,
      consumerId,
      amountDisplay,
    })
    return res.status(201).json({
      licenseId: license.licenseId,
      status: license.status,
      paymentRequest: license.requestEncoded,
      amountDisplay: license.amountDisplay,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to create beat license intent.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/beats/live/:id/license/:network', async (req, res) => {
  const network = req.params.network === 'mainnet' ? 'mainnet' : 'testnet'
  const { id } = req.params
  const { consumerId, amountDisplay } = req.body ?? {}

  if (typeof consumerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected consumerId as a string.',
    })
  }

  const normalizedAmount = Number.parseFloat(amountDisplay || '12.00')
  const safeAmount = Number.isFinite(normalizedAmount) ? normalizedAmount : 12
  const tokenAmount = safeAmount.toFixed(2)
  const mppx = liveMppByNetwork[network]

  try {
    const handler = mppx.tempo.charge({
      amount: tokenAmount,
      description: `Beat ${id} license for consumer ${consumerId}`,
      externalId: `beats_live_${id}_${consumerId}_${Date.now()}`,
    })
    const mppResponse = await handler(toFetchRequest(req))

    if (mppResponse.status === 402) {
      return sendFetchResponse(res, mppResponse.challenge)
    }

    const licenseIntent = createBeatLicenseIntent({
      beatId: id,
      consumerId,
      amountDisplay: tokenAmount,
    })
    const license = grantBeatLicense({ licenseId: licenseIntent.licenseId })

    const successResponse = mppResponse.withReceipt(
      Response.json({
        ok: true,
        network,
        licenseId: license.licenseId,
        status: license.status,
        streamUrl: license.streamUrl,
        receipt: license.receipt,
      }),
    )
    return sendFetchResponse(res, successResponse)
  } catch (error) {
    return res.status(400).json({
      error: 'Live beat license payment failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/beats/live/:id/confirm-by-tx', async (req, res) => {
  const { id } = req.params
  const { txHash, consumerId, amountDisplay, network } = req.body ?? {}
  const resolvedNetwork = network === 'mainnet' ? 'mainnet' : 'testnet'

  if (typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    return res.status(400).json({
      error: 'Invalid payload. Expected txHash as 0x-prefixed hash string.',
    })
  }
  if (typeof consumerId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected consumerId as a string.',
    })
  }

  const normalizedAmount = Number.parseFloat(amountDisplay || '12.00')
  const safeAmount = Number.isFinite(normalizedAmount) ? normalizedAmount : 12
  const tokenAmount = safeAmount.toFixed(2)
  const recoveryKey = `${resolvedNetwork}:${id}:${txHash}`

  try {
    const client = publicClientByNetwork[resolvedNetwork]
    const onchainReceipt = await client.getTransactionReceipt({ hash: txHash })
    if (onchainReceipt.status !== 'success') {
      return res.status(409).json({
        error: 'Transaction found but not successful.',
        txHash,
        onchainStatus: onchainReceipt.status,
      })
    }

    const recovered = beatsLiveRecoveryByTx.get(recoveryKey)
    if (recovered) {
      return res.status(200).json({ ...recovered, recovered: true, txHash })
    }

    const licenseIntent = createBeatLicenseIntent({
      beatId: id,
      consumerId,
      amountDisplay: tokenAmount,
    })
    const license = grantBeatLicense({ licenseId: licenseIntent.licenseId })
    const payload = {
      network: resolvedNetwork,
      licenseId: license.licenseId,
      status: license.status,
      streamUrl: license.streamUrl,
      receipt: license.receipt,
    }
    beatsLiveRecoveryByTx.set(recoveryKey, payload)
    return res.status(200).json({ ...payload, recovered: true, txHash })
  } catch (error) {
    return res.status(404).json({
      error: 'Transaction not confirmed yet.',
      details: error instanceof Error ? error.message : 'Unknown error',
      txHash,
    })
  }
})

app.post('/api/beats/:id/grant-access', (req, res) => {
  const { id } = req.params
  const { licenseId } = req.body ?? {}

  if (typeof licenseId !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected licenseId as a string.',
    })
  }

  try {
    const license = grantBeatLicense({ licenseId })
    if (license.beatId !== id) {
      return res
        .status(400)
        .json({ error: 'licenseId does not belong to this beat.' })
    }
    return res.json({
      licenseId: license.licenseId,
      status: license.status,
      streamUrl: license.streamUrl,
      receipt: license.receipt,
    })
  } catch (error) {
    return res.status(400).json({
      error: 'Failed to grant beat access.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/judges/score', (req, res) => {
  const r = executeDanceExtraFlow('judge-score', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/cypher/micropot/contribute', (req, res) => {
  const r = executeDanceExtraFlow('cypher-micropot', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/clips/sale', (req, res) => {
  const r = executeDanceExtraFlow('clip-sale', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/reputation/attest', (req, res) => {
  const r = executeDanceExtraFlow('reputation', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/studio/ai-usage', (req, res) => {
  const r = executeDanceExtraFlow('ai-usage', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/bot/action', (req, res) => {
  const r = executeDanceExtraFlow('bot-action', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

app.post('/api/ops/agentmail/send', async (req, res) => {
  const { to, subject, text, html, inbox_id, network } = req.body ?? {}
  const effectiveInboxId = typeof inbox_id === 'string' && inbox_id.trim() ? inbox_id.trim() : process.env.AGENTMAIL_INBOX_ID
  const agentmailApiKey = process.env.AGENTMAIL_API_KEY

  if (typeof to !== 'string' || typeof subject !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected to and subject as strings.',
    })
  }

  if (typeof effectiveInboxId !== 'string' || !effectiveInboxId.trim()) {
    return res.status(400).json({
      error: 'Missing inbox_id for AgentMail send.',
      details: 'Provide `inbox_id` in request body or set AGENTMAIL_INBOX_ID on the server.',
    })
  }

  // Alternative strategy (more reliable in this environment):
  // 1) wallet pays this backend via Tempo MPP challenge
  // 2) backend executes AgentMail send via stable API-key endpoint
  //
  // This preserves wallet-paid UX while avoiding AgentMail MPP inbox scope mismatch.
  if (typeof agentmailApiKey === 'string' && agentmailApiKey.trim()) {
    const selectedNetwork = network === 'testnet' ? 'testnet' : 'mainnet'
    const mppx = liveMppByNetwork[selectedNetwork]
    const amount = Number.parseFloat(process.env.AGENTMAIL_SEND_FEE || '0.01')
    const safeAmount = Number.isFinite(amount) ? amount : 0.01
    const tokenAmount = safeAmount.toFixed(2)

    try {
      const handler = mppx.tempo.charge({
        amount: tokenAmount,
        description: `AgentMail send to ${to}`,
        externalId: `agentmail_send_${effectiveInboxId}_${Date.now()}`,
      })
      const mppResponse = await handler(toFetchRequest(req))
      if (mppResponse.status === 402) return sendFetchResponse(res, mppResponse.challenge)

      const apiBase = process.env.AGENTMAIL_BASE_URL || 'https://api.agentmail.to'
      const endpoint = `${apiBase.replace(/\/$/, '')}/v0/inboxes/${encodeURIComponent(effectiveInboxId)}/messages/send`
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${agentmailApiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          subject,
          ...(typeof text === 'string' ? { text } : {}),
          ...(typeof html === 'string' ? { html } : {}),
        }),
      })

      const raw = await upstream.text()
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          error: 'AgentMail send failed.',
          upstreamStatus: upstream.status,
          upstreamEndpoint: endpoint,
          details: data ?? raw,
        })
      }

      const success = mppResponse.withReceipt(
        Response.json({
          provider: 'agentmail',
          status: 'sent',
          result: data ?? raw,
        }, { status: 201 }),
      )
      return sendFetchResponse(res, success)
    } catch (error) {
      return res.status(500).json({
        error: 'AgentMail request failed.',
        details: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  // No API key available: direct AgentMail MPP passthrough mode.
  const mppBaseUrl = process.env.AGENTMAIL_MPP_BASE_URL || 'https://mpp.api.agentmail.to'
  const endpoint = `${mppBaseUrl.replace(/\/$/, '')}/v0/inboxes/${encodeURIComponent(effectiveInboxId)}/messages/send`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Includes `Payment` and `Payment-Receipt` headers when the client
        // successfully solves an x402 challenge via mppx.
        ...getForwardAuthHeaders(req),
      },
      body: JSON.stringify({
        inbox_id: effectiveInboxId,
        to,
        subject,
        ...(typeof text === 'string' ? { text } : {}),
        ...(typeof html === 'string' ? { html } : {}),
      }),
    })

    // Preserve x402 challenge headers on 402 so the mppx client can solve and retry.
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'AgentMail send failed.',
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        details: data ?? raw,
      })
    }
    return res.status(201).json({
      provider: 'agentmail',
      status: 'sent',
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'AgentMail request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// Create an AgentMail inbox using wallet-paid MPP (x402).
// The browser uses mppx/client to pay and forwards the resulting Payment headers to this route.
app.post('/api/ops/agentmail/inbox/create', async (req, res) => {
  const { username, domain, display_name, client_id } = req.body ?? {}
  const mppBaseUrl = process.env.AGENTMAIL_MPP_BASE_URL || 'https://mpp.api.agentmail.to'
  const endpoint = `${mppBaseUrl.replace(/\/$/, '')}/v0/inboxes`
  const agentmailApiKey = process.env.AGENTMAIL_API_KEY

  // AgentMail can auto-generate an inbox if `username` is omitted.
  // Validate only that provided fields are strings.
  const providedTypesOk =
    (typeof username === 'undefined' || typeof username === 'string') &&
    (typeof domain === 'undefined' || typeof domain === 'string') &&
    (typeof display_name === 'undefined' || typeof display_name === 'string') &&
    (typeof client_id === 'undefined' || typeof client_id === 'string')
  if (!providedTypesOk) {
    return res.status(400).json({
      error: 'Invalid payload for AgentMail inbox create.',
      details: 'Expected `username`, `domain`, `display_name`, and `client_id` as strings when provided.',
    })
  }

  const payload = {}
  if (typeof username === 'string' && username.trim()) payload.username = username.trim()
  if (typeof domain === 'string' && domain.trim()) payload.domain = domain.trim()
  if (typeof display_name === 'string' && display_name.trim()) payload.display_name = display_name.trim()
  if (typeof client_id === 'string' && client_id.trim()) payload.client_id = client_id.trim()

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(typeof agentmailApiKey === 'string' && agentmailApiKey.trim()
          ? { Authorization: `Bearer ${agentmailApiKey.trim()}` }
          : {}),
        ...getForwardAuthHeaders(req), // includes `payment` and `payment-receipt` when solved
      },
      body: JSON.stringify(payload),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'AgentMail inbox create failed.',
        details: data ?? raw,
      })
    }

    return res.status(200).json({
      provider: 'agentmail',
      status: 'created',
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'AgentMail inbox create request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/fan-pass/purchase', (req, res) => {
  const r = executeDanceExtraFlow('fan-pass', req.body ?? {})
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  return res.status(r.status).json(r.result)
})

/** GET — verify this server build exposes live dance-extras (useful when debugging 404 from stale `npm run server`). */
app.get('/api/dance-extras/live', (_req, res) => {
  res.json({
    ok: true,
    method: 'POST',
    path: '/api/dance-extras/live/:flowKey/:network',
    flowKeys: Object.keys(DANCE_EXTRA_LIVE_AMOUNTS),
    networks: ['testnet', 'mainnet'],
  })
})

/**
 * Wallet-paid Tempo MPP (x402) for the seven DanceTech “extra” flows — charges then runs the same scaffold as mock routes.
 * Body: same JSON as the corresponding `/api/...` route; `network` in the URL overrides body for Tempo chain selection.
 */
app.post('/api/dance-extras/live/:flowKey/:networkParam', async (req, res) => {
  const network = req.params.networkParam === 'mainnet' ? 'mainnet' : 'testnet'
  const flowKey = req.params.flowKey
  if (!DANCE_EXTRA_LIVE_AMOUNTS[flowKey]) {
    return res.status(400).json({ error: 'Invalid flowKey for live MPP.' })
  }
  const amount = DANCE_EXTRA_LIVE_AMOUNTS[flowKey]
  const mppx = liveMppByNetwork[network]
  try {
    const handler = mppx.tempo.charge({
      amount,
      description: `DanceTech ${flowKey}`,
      externalId: `dance_extra_${flowKey}_${Date.now()}`,
    })
    const mppResponse = await handler(toFetchRequest(req))
    if (mppResponse.status === 402) return sendFetchResponse(res, mppResponse.challenge)

    const body = { ...(req.body ?? {}), network }
    const r = executeDanceExtraFlow(flowKey, body)
    if (!r.ok) {
      return sendFetchResponse(res, Response.json({ error: r.error }, { status: r.status }))
    }
    const successResponse = mppResponse.withReceipt(
      Response.json({ ...r.result, mpp: true, livePayment: true }),
    )
    return sendFetchResponse(res, successResponse)
  } catch (error) {
    return res.status(400).json({
      error: 'Dance extra live payment failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/token/tip20/launch', (req, res) => {
  const {
    name,
    symbol,
    decimals,
    totalSupply,
    ownerAddress,
    network,
  } = req.body ?? {}

  if (typeof name !== 'string' || typeof symbol !== 'string' || typeof ownerAddress !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected name, symbol, and ownerAddress as strings.',
    })
  }

  const parsedDecimals = Number(decimals ?? 18)
  const parsedSupply = Number(totalSupply ?? 1000000)
  if (!Number.isFinite(parsedDecimals) || parsedDecimals < 0 || parsedDecimals > 18) {
    return res.status(400).json({ error: 'Invalid decimals. Expected number between 0 and 18.' })
  }
  if (!Number.isFinite(parsedSupply) || parsedSupply <= 0) {
    return res.status(400).json({ error: 'Invalid totalSupply. Expected positive number.' })
  }

  const launch = {
    launchId: `tip20_${Date.now()}`,
    network: network === 'mainnet' ? 'mainnet' : 'testnet',
    name: name.trim(),
    symbol: symbol.trim().toUpperCase(),
    decimals: parsedDecimals,
    totalSupply: parsedSupply,
    ownerAddress: ownerAddress.trim(),
    factoryAddress: '0x20fc000000000000000000000000000000000000',
    tokenAddress: randomHexAddress(),
    status: 'created',
    createdAt: new Date().toISOString(),
  }

  const receipt = Receipt.from({
    method: 'tempo',
    reference: `tip20_launch_${launch.symbol}_${launch.launchId}`,
    status: 'success',
    timestamp: launch.createdAt,
    externalId: launch.launchId,
  })

  const result = { ...launch, receipt }
  tip20Launches.unshift(result)
  if (tip20Launches.length > 100) tip20Launches.pop()

  return res.status(201).json(result)
})

app.get('/api/token/tip20/launches', (_req, res) => {
  return res.json({ items: tip20Launches })
})

app.post('/api/travel/stable/flights-search', async (req, res) => {
  const { originLocationCode, destinationLocationCode, departureDate, adults, max } = req.body ?? {}

  if (
    typeof originLocationCode !== 'string' ||
    typeof destinationLocationCode !== 'string' ||
    typeof departureDate !== 'string'
  ) {
    return res.status(400).json({
      error:
        'Invalid payload. Expected originLocationCode, destinationLocationCode, departureDate as strings.',
    })
  }

  const search = new URLSearchParams({
    originLocationCode,
    destinationLocationCode,
    departureDate,
    adults: String(Number.isFinite(Number(adults)) ? Number(adults) : 1),
    max: String(Number.isFinite(Number(max)) ? Number(max) : 5),
  })

  const url = `https://stabletravel.dev/api/flights/search?${search.toString()}`

  try {
    // Forward MPP/x402 payment headers from the client POST so paid retries succeed.
    const forwardHeaders = getForwardAuthHeaders(req)
    const response = await fetch(url, { method: 'GET', headers: forwardHeaders })
    // StableTravel uses x402/MPP. Preserve upstream `402` challenge so the frontend
    // can solve it via `mppx` (Tempo MPP wallet flow).
    if (response.status === 402) return sendFetchResponse(res, response)

    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'StableTravel request failed.',
        details: data ?? text,
        endpoint: url,
      })
    }

    return res.json({
      provider: 'stabletravel',
      endpoint: url,
      result: data ?? text,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'StableTravel integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/travel/aviationstack/flights', async (req, res) => {
  const { flight_iata, dep_iata, arr_iata, flight_status, limit } = req.body ?? {}
  const apiKey = process.env.AVIATIONSTACK_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'AVIATIONSTACK_API_KEY is not set on the server.',
    })
  }

  const baseUrl = process.env.AVIATIONSTACK_BASE_URL || 'http://api.aviationstack.com/v1'
  const endpoint = `${baseUrl.replace(/\/$/, '')}/flights`
  const params = new URLSearchParams({ access_key: apiKey })
  if (typeof flight_iata === 'string' && flight_iata.trim()) params.set('flight_iata', flight_iata)
  if (typeof dep_iata === 'string' && dep_iata.trim()) params.set('dep_iata', dep_iata)
  if (typeof arr_iata === 'string' && arr_iata.trim()) params.set('arr_iata', arr_iata)
  if (typeof flight_status === 'string' && flight_status.trim()) {
    params.set('flight_status', flight_status)
  }
  if (Number.isFinite(Number(limit))) params.set('limit', String(Number(limit)))
  const url = `${endpoint}?${params.toString()}`

  try {
    const response = await fetch(url, { method: 'GET' })
    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Aviationstack request failed.',
        details: data ?? raw,
      })
    }
    return res.json({
      provider: 'aviationstack',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Aviationstack integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/travel/googlemaps/geocode', async (req, res) => {
  const { address, language, region } = req.body ?? {}
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'GOOGLE_MAPS_API_KEY is not set on the server.',
    })
  }

  if (typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({
      error: 'Invalid payload. Expected address as a non-empty string.',
    })
  }

  const baseUrl = process.env.GOOGLE_MAPS_BASE_URL || 'https://maps.googleapis.com/maps/api'
  const endpoint = `${baseUrl.replace(/\/$/, '')}/geocode/json`
  const params = new URLSearchParams({
    key: apiKey,
    address: address.trim(),
  })
  if (typeof language === 'string' && language.trim()) params.set('language', language.trim())
  if (typeof region === 'string' && region.trim()) params.set('region', region.trim())
  const url = `${endpoint}?${params.toString()}`

  try {
    const response = await fetch(url, { method: 'GET' })
    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Google Maps request failed.',
        details: data ?? raw,
      })
    }
    return res.json({
      provider: 'google-maps',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Google Maps integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

let warnedLegacyOpenWeatherPath = false
function resolveOpenWeatherCurrentPath() {
  const raw = process.env.OPENWEATHER_CURRENT_PATH || '/openweather/current-weather'
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  // MPP catalog: POST /openweather/current-weather (not legacy OpenWeather GET /data/2.5/weather).
  if (normalized === '/data/2.5/weather') {
    if (!warnedLegacyOpenWeatherPath) {
      warnedLegacyOpenWeatherPath = true
      console.warn(
        '[openweather] OPENWEATHER_CURRENT_PATH=/data/2.5/weather is not valid on weather.mpp.paywithlocus.com — using /openweather/current-weather. Update .env.',
      )
    }
    return '/openweather/current-weather'
  }
  return normalized
}

app.post('/api/travel/openweather/current', async (req, res) => {
  const { lat, lon, units } = req.body ?? {}
  const apiKey = process.env.OPENWEATHER_API_KEY

  const latNum = Number(lat)
  const lonNum = Number(lon)
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return res.status(400).json({
      error: 'Invalid payload. Expected lat and lon as numbers.',
    })
  }

  const baseUrl = process.env.OPENWEATHER_BASE_URL || 'https://weather.mpp.paywithlocus.com'
  const weatherPath = resolveOpenWeatherCurrentPath()
  const endpoint = `${baseUrl.replace(/\/$/, '')}${weatherPath.startsWith('/') ? weatherPath : `/${weatherPath}`}`

  const payload = {
    lat: latNum,
    lon: lonNum,
  }
  if (typeof units === 'string' && units.trim()) payload.units = units.trim()
  if (typeof apiKey === 'string' && apiKey.trim()) payload.appid = apiKey.trim()

  try {
    const forwardHeaders = getForwardAuthHeaders(req)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...forwardHeaders,
      },
      body: JSON.stringify(payload),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'OpenWeather request failed.',
        details: data ?? raw,
        upstreamEndpoint: endpoint,
        hint:
          !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
            ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set OPENWEATHER_API_KEY on the server.'
            : undefined,
      })
    }

    return res.status(response.status).json({
      provider: 'openweather',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'OpenWeather integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/market/kicksdb/search', async (req, res) => {
  const { query, market, per_page } = req.body ?? {}
  const apiKey = process.env.KICKSDB_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'KICKSDB_API_KEY is not set on the server.',
    })
  }

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({
      error: 'Invalid payload. Expected query as a non-empty string.',
    })
  }

  const baseUrl = process.env.KICKSDB_BASE_URL || 'https://kicksdb.mpp.tempo.xyz'
  const searchPath = process.env.KICKSDB_SEARCH_PATH || '/v3/stockx/products'
  const endpoint = `${baseUrl.replace(/\/$/, '')}${searchPath.startsWith('/') ? searchPath : `/${searchPath}`}`

  const params = new URLSearchParams({ query: query.trim() })
  if (typeof market === 'string' && market.trim()) params.set('market', market.trim().toUpperCase())
  if (Number.isFinite(Number(per_page))) params.set('per_page', String(Number(per_page)))
  const url = `${endpoint}?${params.toString()}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Forward MPP payment headers when the client uses an MPP-capable flow (x402).
        ...getForwardAuthHeaders(req),
      },
    })

    // Preserve x402 challenge headers on 402 so mppx/client can solve and retry.
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'KicksDB request failed.',
        details: data ?? raw,
      })
    }

    return res.json({
      provider: 'kicksdb',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'KicksDB integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

/** MPP Suno catalog uses POST /suno/generate-music (not /api/generate). */
let warnedLegacySunoGeneratePath = false
function resolveSunoGeneratePath() {
  const raw = process.env.SUNO_GENERATE_PATH || '/suno/generate-music'
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  if (normalized === '/api/generate') {
    if (!warnedLegacySunoGeneratePath) {
      warnedLegacySunoGeneratePath = true
      console.warn(
        '[suno] SUNO_GENERATE_PATH=/api/generate is not valid on suno.mpp.paywithlocus.com — using /suno/generate-music. Update .env and restart.',
      )
    }
    return '/suno/generate-music'
  }
  return normalized
}

const SUNO_GENERATE_MODELS = new Set(['V4', 'V4_5', 'V4_5ALL', 'V4_5PLUS', 'V5'])

app.post('/api/music/suno/generate', async (req, res) => {
  const { prompt, style, duration, customMode, instrumental, model } = req.body ?? {}

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({
      error: 'Invalid payload. Expected prompt as a non-empty string.',
    })
  }

  /** Suno MPP `generate-music` requires this flag (simple prompt vs custom lyrics/style flow). */
  const customModeBool = typeof customMode === 'boolean' ? customMode : false
  /** true = no vocals / instrumental track (Suno API requires the boolean). */
  const instrumentalBool = typeof instrumental === 'boolean' ? instrumental : false
  /** Upstream: model is required — must be one of V4, V4_5, … */
  const modelTrim = typeof model === 'string' ? model.trim() : ''
  const modelResolved = SUNO_GENERATE_MODELS.has(modelTrim) ? modelTrim : 'V5'

  const baseUrl = process.env.SUNO_BASE_URL || 'https://suno.mpp.paywithlocus.com'
  const generatePath = resolveSunoGeneratePath()
  const endpoint = `${baseUrl.replace(/\/$/, '')}${generatePath.startsWith('/') ? generatePath : `/${generatePath}`}`

  try {
    const forwardHeaders = getForwardAuthHeaders(req)
    const headers = {
      'Content-Type': 'application/json',
      ...forwardHeaders,
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: prompt.trim(),
        customMode: customModeBool,
        instrumental: instrumentalBool,
        model: modelResolved,
        ...(typeof style === 'string' && style.trim() ? { style: style.trim() } : {}),
        ...(Number.isFinite(Number(duration)) ? { duration: Number(duration) } : {}),
      }),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Suno request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint:
          !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
            ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP) when prompted.'
            : undefined,
      })
    }

    return res.status(response.status).json({
      provider: 'suno',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Suno integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

function parallelUpstreamBase() {
  return (process.env.PARALLEL_BASE_URL || 'https://parallelmpp.dev').replace(/\/$/, '')
}

/**
 * Parallel (web search / extract / task) via MPP — https://parallelmpp.dev
 * Paid POSTs return 402 until wallet pays; GET task poll is free upstream.
 */
async function proxyParallelRequest(req, res, { path: upstreamPath, method = 'POST', jsonBody }) {
  const endpoint = `${parallelUpstreamBase()}${upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`}`
  try {
    const forwardHeaders = getForwardAuthHeaders(req)
    const headers = {
      ...forwardHeaders,
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(endpoint, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(jsonBody ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Parallel request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint:
          method !== 'GET' && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
            ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP) when prompted.'
            : undefined,
      })
    }

    return res.status(response.status).json({
      provider: 'parallel',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Parallel integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.post('/api/parallel/search', (req, res) =>
  proxyParallelRequest(req, res, { path: '/api/search', method: 'POST', jsonBody: req.body ?? {} }),
)

app.post('/api/parallel/extract', (req, res) =>
  proxyParallelRequest(req, res, { path: '/api/extract', method: 'POST', jsonBody: req.body ?? {} }),
)

app.post('/api/parallel/task', (req, res) =>
  proxyParallelRequest(req, res, { path: '/api/task', method: 'POST', jsonBody: req.body ?? {} }),
)

app.get('/api/parallel/task/:runId', (req, res) => {
  const runId = encodeURIComponent(String(req.params.runId ?? ''))
  return proxyParallelRequest(req, res, { path: `/api/task/${runId}`, method: 'GET', jsonBody: null })
})

app.post('/api/ops/stablephone/call', async (req, res) => {
  const { phone_number, task, voice } = req.body ?? {}

  if (typeof phone_number !== 'string' || typeof task !== 'string') {
    return res.status(400).json({
      error: 'Invalid payload. Expected phone_number and task as strings.',
    })
  }

  const baseUrl = process.env.STABLEPHONE_BASE_URL || 'https://stablephone.dev'
  const callPath = process.env.STABLEPHONE_CALL_PATH || '/api/call'
  const endpoint = `${baseUrl.replace(/\/$/, '')}${callPath.startsWith('/') ? callPath : `/${callPath}`}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getForwardAuthHeaders(req),
      },
      body: JSON.stringify({
        phone_number,
        task,
        ...(typeof voice === 'string' && voice.trim() ? { voice: voice.trim() } : {}),
      }),
    })

    // Preserve x402 challenge for `mppx` (same pattern as StableTravel / AgentMail).
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'StablePhone call request failed.',
        details: data ?? raw,
      })
    }

    return res.status(201).json({
      provider: 'stablephone',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'StablePhone integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/ops/stablephone/call/:id', async (req, res) => {
  const callId = req.params.id
  if (typeof callId !== 'string' || !callId.trim()) {
    return res.status(400).json({ error: 'Invalid call id.' })
  }

  const baseUrl = process.env.STABLEPHONE_BASE_URL || 'https://stablephone.dev'
  const statusPath = process.env.STABLEPHONE_STATUS_PATH || '/api/call'
  const endpoint = `${baseUrl.replace(/\/$/, '')}${statusPath.startsWith('/') ? statusPath : `/${statusPath}`}/${encodeURIComponent(callId)}`

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        ...getForwardAuthHeaders(req),
      },
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'StablePhone status request failed.',
        details: data ?? raw,
      })
    }

    return res.json({
      provider: 'stablephone',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'StablePhone status integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/social/stablesocial/instagram-profile', async (req, res) => {
  // StableSocial OpenAPI: POST /api/instagram/profile expects `{ "handle": "..." }` (not `username`).
  const { username, handle } = req.body ?? {}
  const trimmedHandle =
    typeof handle === 'string' && handle.trim()
      ? handle.trim()
      : typeof username === 'string' && username.trim()
        ? username.trim()
        : ''
  if (!trimmedHandle) {
    return res.status(400).json({
      error: 'Invalid payload. Expected `handle` or `username` as a non-empty string.',
    })
  }

  const baseUrl = process.env.STABLESOCIAL_BASE_URL || 'https://stablesocial.dev'
  const profilePath =
    process.env.STABLESOCIAL_INSTAGRAM_PROFILE_PATH || '/api/instagram/profile'
  const endpoint = `${baseUrl.replace(/\/$/, '')}${profilePath.startsWith('/') ? profilePath : `/${profilePath}`}`

  try {
    const forwardHeaders = getForwardAuthHeaders(req)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...forwardHeaders,
      },
      body: JSON.stringify({ handle: trimmedHandle }),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'StableSocial request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
      })
    }

    return res.status(response.status).json({
      provider: 'stablesocial',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'StableSocial integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/social/stablesocial/jobs', async (req, res) => {
  const token = req.query.token
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({
      error: 'Missing token query parameter.',
    })
  }

  const baseUrl = process.env.STABLESOCIAL_BASE_URL || 'https://stablesocial.dev'
  const jobsPath = process.env.STABLESOCIAL_JOBS_PATH || '/api/jobs'
  const endpoint = `${baseUrl.replace(/\/$/, '')}${jobsPath.startsWith('/') ? jobsPath : `/${jobsPath}`}`
  const url = `${endpoint}?${new URLSearchParams({ token }).toString()}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...getForwardAuthHeaders(req),
      },
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      const hints = []
      if (response.status === 401 || response.status === 403) {
        hints.push('SIWX must be from the same wallet that paid for the job token.')
      }
      // https://stablesocial.dev/llms.txt — "502 — Upstream data collection failed"
      if (response.status === 502) {
        hints.push(
          'StableSocial reports upstream data collection failed — retry poll later or trigger a new job.',
        )
      }
      return res.status(response.status).json({
        error: 'StableSocial jobs poll failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: url,
        hint: hints.length ? hints.join(' ') : undefined,
      })
    }

    return res.json({
      provider: 'stablesocial',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'StableSocial jobs integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/card/create', async (req, res) => {
  const { walletAddress, amountDisplay, currency, label } = req.body ?? {}
  const requestedNetwork = req.body?.network === 'mainnet' ? 'mainnet' : 'testnet'

  if (typeof walletAddress !== 'string' || !walletAddress.startsWith('0x')) {
    return res.status(400).json({
      error: 'Invalid payload. Expected walletAddress as 0x-prefixed string.',
    })
  }

  const providerMode = (process.env.CARD_PROVIDER || 'laso').toLowerCase()
  const useLaso = providerMode === 'laso'

  const respondWithMock = () => {
    try {
      const card = createVirtualDebitCard({ walletAddress, amountDisplay, currency, label })
      return res.status(201).json({
        cardId: card.cardId,
        brand: card.brand,
        provider: card.provider,
        cardNumber: card.cardNumber,
        expiry: card.expiry,
        cvv: card.cvv,
        amountDisplay: card.amountDisplay,
        currency: card.currency,
        status: card.status,
        label: card.label,
        createdAt: card.createdAt,
        receipt: card.receipt,
      })
    } catch (error) {
      return res.status(400).json({
        error: 'Failed to create virtual debit card.',
        details: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const respondWithMockDemo = (demoReason) => {
    try {
      const card = createVirtualDebitCard({ walletAddress, amountDisplay, currency, label })
      lasoCardDemoReasonById.set(card.cardId, demoReason)
      return res.status(201).json({
        cardId: card.cardId,
        brand: card.brand,
        provider: card.provider,
        cardNumber: card.cardNumber,
        expiry: card.expiry,
        cvv: card.cvv,
        amountDisplay: card.amountDisplay,
        currency: card.currency,
        status: card.status,
        label: card.label,
        createdAt: card.createdAt,
        receipt: card.receipt,
        demo: true,
        demoReason,
      })
    } catch (error) {
      return res.status(400).json({
        error: 'Failed to create virtual debit card.',
        details: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const isUsOnlyBlocked = (raw) => {
    const s = String(raw ?? '').toLowerCase()
    return (
      s.includes('us only') ||
      s.includes('united states') ||
      (s.includes('restricted') && s.includes('region')) ||
      (s.includes('not available') && (s.includes('us') || s.includes('united')))
    )
  }

  if (!useLaso) return respondWithMock()

  const mppx = liveMppByNetwork[requestedNetwork]
  const normalizedAmount = Number.parseFloat(amountDisplay || '5.00')
  const safeAmount = Number.isFinite(normalizedAmount) ? normalizedAmount : 5
  // mppx.tempo.charge expects a decimal-string amount (not base units).
  const tokenAmount = safeAmount.toFixed(2)

  try {
    const lasoBase = process.env.LASO_BASE_URL || 'https://laso.mpp.paywithlocus.com'
    const lasoPath = process.env.LASO_MPP_PATH || '/get-card'
    const lasoEndpoint = `${lasoBase.replace(/\/$/, '')}${lasoPath.startsWith('/') ? lasoPath : `/${lasoPath}`}`

    const lasoRequestBody = JSON.stringify({ amount: safeAmount, format: 'json' })
    const lasoHeaders = {
      'Content-Type': 'application/json',
      ...getForwardAuthHeaders(req), // includes `payment` and `payment-receipt` when MPP succeeded
    }

    let upstream = await fetch(lasoEndpoint, {
      method: 'POST',
      headers: lasoHeaders,
      body: lasoRequestBody,
    })

    let raw = await upstream.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    // Geo restricted (e.g. UK): avoid charging if Laso tells us it's US-only.
    const usOnlyCheck = data ? JSON.stringify(data) : raw
    if ((upstream.status === 403 || upstream.status === 400) && isUsOnlyBlocked(usOnlyCheck)) {
      return respondWithMockDemo('Demo mode: Laso prepaid card ordering is restricted to the United States (US only).')
    }

    if (upstream.status !== 402 && !upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Laso virtual card request failed.',
        details: data ?? raw,
        endpoint: lasoEndpoint,
        upstreamStatus: upstream.status,
      })
    }

    let mppResponse = null
    if (upstream.status === 402) {
      const handler = mppx.tempo.charge({
        amount: tokenAmount,
        description: `Virtual debit card creation for ${walletAddress}`,
        externalId: `virtual_card_${walletAddress}_${Date.now()}`,
      })

      mppResponse = await handler(toFetchRequest(req))
      if (mppResponse.status === 402) return sendFetchResponse(res, mppResponse.challenge)

      // Retry Laso now that the request includes payment headers.
      upstream = await fetch(lasoEndpoint, {
        method: 'POST',
        headers: lasoHeaders,
        body: lasoRequestBody,
      })

      raw = await upstream.text()
      data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }

      if (!upstream.ok) {
        const lasoErrText = data ? JSON.stringify(data) : raw
        if (
          upstream.status === 402 &&
          (lasoErrText.toLowerCase().includes('invalid challenge') || isUsOnlyBlocked(lasoErrText))
        ) {
          return respondWithMockDemo(
            'Demo mode: Laso prepaid card ordering is restricted to the United States (US only).',
          )
        }
        const payload = {
          error: 'Laso virtual card request failed.',
          details: data ?? raw,
          endpoint: lasoEndpoint,
          upstreamStatus: upstream.status,
        }
        const errRes = mppResponse.withReceipt(
          new Response(JSON.stringify(payload), {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        return sendFetchResponse(res, errRes)
      }
    }

    const cardData = data?.card || data?.result?.card || data?.result || data
    const auth = data?.auth || data?.authentication || {}
    const orderedCardId = cardData?.card_id || cardData?.cardId || cardData?.id || ''
    const idToken = auth?.id_token || auth?.idToken || ''
    const refreshToken = auth?.refresh_token || auth?.refreshToken || ''

    if (orderedCardId && idToken && refreshToken) {
      lasoCardAuthById.set(orderedCardId, { idToken, refreshToken })
    }

    const cardStatus = cardData?.status || 'pending'
    const payload = {
      provider: 'laso',
      source: 'laso-mpp',
      cardId: orderedCardId,
      brand: 'Visa',
      // /get-card returns pending card orders initially; poll /get-card-data for details.
      cardNumber: '',
      expiry: '',
      cvv: '',
      amountDisplay: safeAmount.toFixed(2),
      currency: 'USD',
      status: cardStatus === 'ready' ? 'ready' : 'idle',
      label: label || '',
      createdAt: new Date().toISOString(),
      receipt: null,
      raw: data ?? raw,
    }

    if (mppResponse) {
      const successRes = mppResponse.withReceipt(
        new Response(JSON.stringify(payload), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      return sendFetchResponse(res, successRes)
    }

    return res.status(201).json(payload)
  } catch (error) {
    return res.status(400).json({
      error: 'Virtual card MPP payment failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.get('/api/card/:id', async (req, res) => {
  const providerMode = (process.env.CARD_PROVIDER || 'laso').toLowerCase()
  const useLaso = providerMode === 'laso'

  if (!useLaso) {
    const card = getVirtualDebitCard(req.params.id)
    if (!card) return res.status(404).json({ error: 'Virtual card not found.' })
    return res.json(card)
  }

  const cardId = req.params.id
  if (typeof cardId !== 'string' || cardId.length === 0) {
    return res.status(400).json({ error: 'Invalid card id.' })
  }

  const lasoBase = process.env.LASO_BASE_URL || 'https://laso.mpp.paywithlocus.com'
  const statusPath = process.env.LASO_CARD_STATUS_PATH || '/get-card-data'
  const lasoEndpoint = `${lasoBase.replace(/\/$/, '')}${statusPath.startsWith('/') ? statusPath : `/${statusPath}`}`

  const authEntry = lasoCardAuthById.get(cardId)
  if (!authEntry?.idToken || !authEntry?.refreshToken) {
    // Demo fallback: if we already served a mock card (e.g. Laso US-only geo restriction),
    // we should still be able to poll and return the stored mock telemetry.
    const mock = getVirtualDebitCard(cardId)
    if (mock) {
      const demoReason = lasoCardDemoReasonById.get(cardId)
      return res.json({
        ...mock,
        provider: 'laso',
        source: 'laso-mpp',
        demo: true,
        demoReason,
      })
    }

    return res.status(400).json({
      error: 'Missing Laso auth tokens for this cardId.',
      details: 'Create the card first so we can store id_token/refresh_token for polling.',
      cardId,
    })
  }

  const callGetCardData = async (idToken) => {
    const upstream = await fetch(lasoEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...getForwardAuthHeaders(req),
      },
      body: JSON.stringify({ card_id: cardId, format: 'json' }),
    })

    const raw = await upstream.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    return { upstream, raw, data }
  }

  try {
    let { upstream, raw, data } = await callGetCardData(authEntry.idToken)

    if (upstream.status === 401) {
      // Refresh id_token when it expires.
      const refreshEndpoint = `${lasoBase.replace(/\/$/, '')}/auth`
      const refreshRes = await fetch(refreshEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: authEntry.refreshToken,
        }),
      })
      const refreshRaw = await refreshRes.text()
      let refreshData = null
      try {
        refreshData = refreshRaw ? JSON.parse(refreshRaw) : null
      } catch {
        refreshData = null
      }

      if (!refreshRes.ok) {
        return res.status(refreshRes.status).json({
          error: 'Laso auth refresh failed while polling card data.',
          details: refreshData ?? refreshRaw,
        })
      }

      const newIdToken = refreshData?.id_token || refreshData?.idToken || ''
      const newRefreshToken = refreshData?.refresh_token || refreshData?.refreshToken || authEntry.refreshToken
      if (!newIdToken) {
        return res.status(401).json({
          error: 'Laso auth refresh returned no id_token.',
          details: refreshData ?? refreshRaw,
        })
      }

      lasoCardAuthById.set(cardId, {
        idToken: newIdToken,
        refreshToken: newRefreshToken,
      })

      ;({ upstream, raw, data } = await callGetCardData(newIdToken))
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Laso card status request failed.',
        details: data ?? raw,
        endpoint: lasoEndpoint,
      })
    }

    const cardData = data
    const details = cardData?.card_details || {}
    const expMonth = details?.exp_month || ''
    const expYear = details?.exp_year || ''
    const expiry =
      expMonth && expYear
        ? `${String(expMonth).padStart(2, '0')}/${String(expYear).slice(-2)}`
        : cardData?.expiry || ''

    return res.json({
      provider: 'laso',
      source: 'laso-mpp',
      cardId: cardData?.card_id || cardData?.cardId || cardId,
      status: cardData?.status || 'unknown',
      cardNumber: details?.card_number || '',
      expiry,
      cvv: details?.cvv || '',
      balance: details?.available_balance ?? null,
      receipt: null,
      raw: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Laso card status integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

function openAiMppBaseUrl() {
  return (process.env.OPENAI_MPP_BASE_URL || 'https://openai.mpp.tempo.xyz').replace(/\/$/, '')
}

function openAiMppAuthHeaders(req) {
  const apiKey = process.env.OPENAI_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function openAiMppPaymentHint(req) {
  const apiKey = process.env.OPENAI_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set OPENAI_API_KEY on the server.'
    : undefined
}

/**
 * OpenAI MPP JSON POST proxy (chat, images, …).
 * @see https://mpp.dev/services — OpenAI on Tempo
 */
async function proxyOpenAiMppJson(req, res, upstreamPath, jsonBody) {
  const endpoint = `${openAiMppBaseUrl()}${upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`}`
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...openAiMppAuthHeaders(req),
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonBody ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'OpenAI MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: openAiMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'openai-mpp',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'OpenAI MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.post('/api/openai/chat/completions', (req, res) =>
  proxyOpenAiMppJson(req, res, '/v1/chat/completions', req.body ?? {}),
)

app.post('/api/openai/images/generations', (req, res) =>
  proxyOpenAiMppJson(req, res, '/v1/images/generations', req.body ?? {}),
)

/** Text-to-speech — upstream returns audio bytes; we wrap as base64 JSON for the browser. */
app.post('/api/openai/audio/speech', async (req, res) => {
  const endpoint = `${openAiMppBaseUrl()}/v1/audio/speech`
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...openAiMppAuthHeaders(req),
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const buf = Buffer.from(await response.arrayBuffer())
    const ct = response.headers.get('content-type') || ''

    if (!response.ok) {
      let details = buf.toString('utf8')
      try {
        details = JSON.parse(details)
      } catch {
        /* keep string */
      }
      return res.status(response.status).json({
        error: 'OpenAI MPP speech request failed.',
        details,
        upstreamEndpoint: endpoint,
        hint: openAiMppPaymentHint(req),
      })
    }

    if (ct.includes('application/json')) {
      let data = null
      try {
        data = JSON.parse(buf.toString('utf8'))
      } catch {
        data = buf.toString('utf8')
      }
      return res.status(200).json({
        provider: 'openai-mpp',
        endpoint,
        result: data,
      })
    }

    const mime = ct.split(';')[0].trim() || 'audio/mpeg'
    return res.status(200).json({
      provider: 'openai-mpp',
      endpoint,
      result: {
        mime,
        audio_base64: buf.toString('base64'),
      },
    })
  } catch (error) {
    return res.status(500).json({
      error: 'OpenAI MPP speech integration failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

/** Whisper transcription — multipart file field `file` + `model`. */
app.post('/api/openai/audio/transcriptions', openAiMppUpload.single('file'), async (req, res) => {
  const endpoint = `${openAiMppBaseUrl()}/v1/audio/transcriptions`
  const file = req.file
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : 'whisper-1'

  if (!file?.buffer) {
    return res.status(400).json({
      error: 'Missing audio file. Send multipart/form-data with field "file".',
    })
  }

  try {
    const form = new FormData()
    form.append('file', new Blob([file.buffer]), file.originalname || 'audio.webm')
    form.append('model', model)

    const headers = openAiMppAuthHeaders(req)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'OpenAI MPP transcription request failed.',
        details: data ?? raw,
        upstreamEndpoint: endpoint,
        hint: openAiMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'openai-mpp',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'OpenAI MPP transcription integration failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

function anthropicMppBaseUrl() {
  return (process.env.ANTHROPIC_MPP_BASE_URL || 'https://anthropic.mpp.tempo.xyz').replace(/\/$/, '')
}

/** Anthropic-native headers; MPP still uses Payment / Payment-Receipt from the browser when no key. */
function anthropicMppAuthHeaders(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim()
    headers['anthropic-version'] = process.env.ANTHROPIC_API_VERSION?.trim() || '2023-06-01'
  }
  return headers
}

function anthropicMppPaymentHint(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set ANTHROPIC_API_KEY on the server.'
    : undefined
}

/**
 * Anthropic MPP JSON POST proxy (Messages API + OpenAI-compatible chat).
 * @see https://mpp.dev/services — Anthropic on Tempo
 */
async function proxyAnthropicMppJson(req, res, upstreamPath, jsonBody) {
  const endpoint = `${anthropicMppBaseUrl()}${upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`}`
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...anthropicMppAuthHeaders(req),
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonBody ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Anthropic MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: anthropicMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'anthropic-mpp',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Anthropic MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.post('/api/anthropic/v1/messages', (req, res) =>
  proxyAnthropicMppJson(req, res, '/v1/messages', req.body ?? {}),
)

app.post('/api/anthropic/v1/chat/completions', (req, res) =>
  proxyAnthropicMppJson(req, res, '/v1/chat/completions', req.body ?? {}),
)

function openRouterMppBaseUrl() {
  return (process.env.OPENROUTER_MPP_BASE_URL || 'https://openrouter.mpp.tempo.xyz').replace(/\/$/, '')
}

/** OpenRouter uses Bearer auth; forward MPP payment headers from the browser when no key. */
function openRouterMppAuthHeaders(req) {
  const apiKey = process.env.OPENROUTER_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function openRouterMppPaymentHint(req) {
  const apiKey = process.env.OPENROUTER_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set OPENROUTER_API_KEY on the server.'
    : undefined
}

/**
 * OpenRouter MPP JSON POST proxy (OpenAI-compatible chat).
 * @see https://mpp.dev/services#openrouter
 */
async function proxyOpenRouterMppJson(req, res, upstreamPath, jsonBody) {
  const endpoint = `${openRouterMppBaseUrl()}${upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`}`
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...openRouterMppAuthHeaders(req),
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonBody ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'OpenRouter MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: openRouterMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'openrouter-mpp',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'OpenRouter MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.post('/api/openrouter/v1/chat/completions', (req, res) =>
  proxyOpenRouterMppJson(req, res, '/v1/chat/completions', req.body ?? {}),
)

function perplexityMppBaseUrl() {
  return (process.env.PERPLEXITY_MPP_BASE_URL || 'https://perplexity.mpp.tempo.xyz').replace(/\/$/, '')
}

/** Perplexity uses Bearer auth; forward MPP payment headers from the browser when no key. */
function perplexityMppAuthHeaders(req) {
  const apiKey = process.env.PERPLEXITY_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function perplexityMppPaymentHint(req) {
  const apiKey = process.env.PERPLEXITY_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set PERPLEXITY_API_KEY on the server.'
    : undefined
}

/**
 * Perplexity MPP JSON POST proxy (chat, search, embeddings).
 * @see https://mpp.dev/services#perplexity
 */
async function proxyPerplexityMppJson(req, res, upstreamPath, jsonBody) {
  const endpoint = `${perplexityMppBaseUrl()}${upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`}`
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...perplexityMppAuthHeaders(req),
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonBody ?? {}),
    })

    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Perplexity MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: perplexityMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'perplexity-mpp',
      endpoint,
      result: data ?? raw,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Perplexity MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.post('/api/perplexity/chat', (req, res) =>
  proxyPerplexityMppJson(req, res, '/perplexity/chat', req.body ?? {}),
)

app.post('/api/perplexity/search', (req, res) =>
  proxyPerplexityMppJson(req, res, '/perplexity/search', req.body ?? {}),
)

app.post('/api/perplexity/embed', (req, res) =>
  proxyPerplexityMppJson(req, res, '/perplexity/embed', req.body ?? {}),
)

app.post('/api/perplexity/context-embed', (req, res) =>
  proxyPerplexityMppJson(req, res, '/perplexity/context-embed', req.body ?? {}),
)

function alchemyMppBaseUrl() {
  return (process.env.ALCHEMY_MPP_BASE_URL || 'https://mpp.alchemy.com').replace(/\/$/, '')
}

/** Alchemy MPP uses Bearer when ALCHEMY_API_KEY is set; otherwise forward MPP payment headers from the browser. */
function alchemyMppAuthHeaders(req) {
  const apiKey = process.env.ALCHEMY_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function alchemyMppPaymentHint(req) {
  const apiKey = process.env.ALCHEMY_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set ALCHEMY_API_KEY on the server.'
    : undefined
}

/**
 * Alchemy MPP proxy — forwards to `/:network/v2` (JSON-RPC) and `/:network/nft/v3/...` (NFT API v3).
 * Browser calls `/api/alchemy/...`; upstream path is the same without the `/api` prefix.
 * @see https://mpp.dev/services#alchemy
 */
async function proxyAlchemyMpp(req, res) {
  const suffix = req.url || '/'
  const endpoint = `${alchemyMppBaseUrl()}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  const method = (req.method || 'GET').toUpperCase()

  const headers = { ...alchemyMppAuthHeaders(req) }
  const fetchOpts = { method, headers }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const payload = req.body !== undefined && req.body !== null ? req.body : {}
    fetchOpts.headers = { ...headers, 'Content-Type': 'application/json' }
    fetchOpts.body = JSON.stringify(payload)
  }

  try {
    const response = await fetch(endpoint, fetchOpts)
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Alchemy MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: alchemyMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'alchemy-mpp',
      endpoint,
      result: data,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Alchemy MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.use('/api/alchemy', (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET,HEAD,POST,OPTIONS')
    return res.status(204).end()
  }
  return proxyAlchemyMpp(req, res)
})

function falMppBaseUrl() {
  return (process.env.FAL_MPP_BASE_URL || 'https://fal.mpp.tempo.xyz').replace(/\/$/, '')
}

/** fal.ai MPP uses Bearer when FAL_API_KEY is set; otherwise forward MPP payment headers from the browser. */
function falMppAuthHeaders(req) {
  const apiKey = process.env.FAL_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function falMppPaymentHint(req) {
  const apiKey = process.env.FAL_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set FAL_API_KEY on the server.'
    : undefined
}

/**
 * fal.ai MPP proxy — image / video / audio model endpoints (`POST /fal-ai/...`, `POST /xai/...`, etc.).
 * Browser calls `/api/fal/...`; upstream path is the same without the `/api` prefix.
 * @see https://mpp.dev/services#fal
 */
async function proxyFalMpp(req, res) {
  const suffix = req.url || '/'
  const endpoint = `${falMppBaseUrl()}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  const method = (req.method || 'GET').toUpperCase()

  const headers = { ...falMppAuthHeaders(req) }
  const fetchOpts = { method, headers }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const payload = req.body !== undefined && req.body !== null ? req.body : {}
    fetchOpts.headers = { ...headers, 'Content-Type': 'application/json' }
    fetchOpts.body = JSON.stringify(payload)
  }

  try {
    const response = await fetch(endpoint, fetchOpts)
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'fal MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: falMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'fal-mpp',
      endpoint,
      result: data,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'fal MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.use('/api/fal', (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET,HEAD,POST,OPTIONS')
    return res.status(204).end()
  }
  return proxyFalMpp(req, res)
})

function replicateMppBaseUrl() {
  return (process.env.REPLICATE_MPP_BASE_URL || 'https://replicate.mpp.paywithlocus.com').replace(/\/$/, '')
}

/** Replicate MPP uses Bearer when REPLICATE_API_KEY is set; otherwise forward MPP payment headers from the browser. */
function replicateMppAuthHeaders(req) {
  const apiKey = process.env.REPLICATE_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  const headers = { ...forwardHeaders }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function replicateMppPaymentHint(req) {
  const apiKey = process.env.REPLICATE_API_KEY
  const forwardHeaders = getForwardAuthHeaders(req)
  return !apiKey?.trim() && !forwardHeaders.Payment && !forwardHeaders['Payment-Receipt']
    ? 'Connect wallet on Tempo mainnet and complete payment (x402 / MPP), or set REPLICATE_API_KEY on the server.'
    : undefined
}

/**
 * Replicate MPP proxy — `POST /replicate/run`, `/replicate/get-prediction`, `/replicate/get-model`, `/replicate/list-models`.
 * Browser calls `/api/replicate/...`; upstream path is the same without the `/api` prefix.
 * @see https://mpp.dev/services#replicate
 */
async function proxyReplicateMpp(req, res) {
  const suffix = req.url || '/'
  const endpoint = `${replicateMppBaseUrl()}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  const method = (req.method || 'GET').toUpperCase()

  const headers = { ...replicateMppAuthHeaders(req) }
  const fetchOpts = { method, headers }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const payload = req.body !== undefined && req.body !== null ? req.body : {}
    fetchOpts.headers = { ...headers, 'Content-Type': 'application/json' }
    fetchOpts.body = JSON.stringify(payload)
  }

  try {
    const response = await fetch(endpoint, fetchOpts)
    if (response.status === 402) return sendFetchResponse(res, response)

    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Replicate MPP request failed.',
        details: data ?? raw,
        upstreamStatus: response.status,
        upstreamEndpoint: endpoint,
        hint: replicateMppPaymentHint(req),
      })
    }

    return res.status(response.status).json({
      provider: 'replicate-mpp',
      endpoint,
      result: data,
    })
  } catch (error) {
    return res.status(500).json({
      error: 'Replicate MPP integration request failed.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

app.use('/api/replicate', (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET,HEAD,POST,OPTIONS')
    return res.status(204).end()
  }
  return proxyReplicateMpp(req, res)
})

app.post('/api/ai/explain-flow', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const { flowTitle, flowSubtitle, steps } = req.body ?? {}

  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY is not set on the server.',
    })
  }

  if (
    typeof flowTitle !== 'string' ||
    typeof flowSubtitle !== 'string' ||
    !Array.isArray(steps) ||
    steps.length === 0
  ) {
    return res.status(400).json({
      error: 'Invalid payload. Expected flowTitle, flowSubtitle, and steps[].',
    })
  }

  try {
    const prompt = [
      'You are explaining a DanceTech payment flow to non-technical users.',
      'Return 3 short bullets:',
      '1) Why this flow matters',
      '2) How payment works with MPP + Tempo',
      '3) What user trust benefit they get',
      '',
      `Flow title: ${flowTitle}`,
      `Flow subtitle: ${flowSubtitle}`,
      `Steps: ${steps.join(' -> ')}`,
    ].join('\n')

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content:
              'You write concise product explanations for payment-enabled web apps. Keep it plain and practical.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(response.status).json({
        error: 'OpenAI request failed.',
        details: errorText,
      })
    }

    const data = await response.json()
    const explanation = data?.choices?.[0]?.message?.content?.trim()

    if (!explanation) {
      return res.status(502).json({ error: 'OpenAI returned an empty response.' })
    }

    return res.json({ explanation, model })
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected AI proxy error.',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`)
  console.log(`  Dance extras (live MPP): POST /api/dance-extras/live/:flowKey/:network  (GET /api/dance-extras/live to verify)`)
})
