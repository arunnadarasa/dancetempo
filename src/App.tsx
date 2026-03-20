import { useState } from 'react'
import { AGENTMAIL_DEMO_INBOX_ID } from './agentmailDemo'
import './App.css'
import {
  addTxHistory,
  clearTxHistory,
  explorerTxUrl,
  listTxHistory,
  type TxFlow,
  type TxHistoryItem,
  type TxNetwork,
} from './txHistory'

type FlowKey = 'battle' | 'coaching' | 'beats'
type ExtraFlowKey =
  | 'judge-score'
  | 'cypher-micropot'
  | 'clip-sale'
  | 'reputation'
  | 'ai-usage'
  | 'bot-action'
  | 'fan-pass'
  | 'virtual-card'
  | 'travel-logistics'
  | 'flight-tracking'
  | 'geo-routing'
  | 'sneaker-intel'
  | 'weather-ops'
  | 'suno-beatgen'
  | 'voice-ops'
  | 'social-intel'

const flowCopy: Record<
  FlowKey,
  { title: string; subtitle: string; intent: 'charge' | 'session'; steps: string[] }
> = {
  battle: {
    title: 'Battle Entry + Auto Payout',
    subtitle:
      'Dancers pay once to register. Winners receive split payouts after organizers finalize results.',
    intent: 'charge',
    steps: [
      'Create event and battle fee',
      'Pay entry with MPP charge',
      'Confirm finality in seconds',
      'Finalize results and auto-distribute prizes',
    ],
  },
  coaching: {
    title: 'Coaching Minutes Marketplace',
    subtitle:
      'Dancers start a live coaching session and pay by time streamed through MPP session billing.',
    intent: 'session',
    steps: [
      'Pick coach and rate',
      'Open MPP session intent',
      'Meter usage every 30 seconds',
      'End session and issue final receipt',
    ],
  },
  beats: {
    title: 'Beat API Licensing',
    subtitle:
      'Consumers buy per-use beat licenses. Access unlocks instantly after one payment.',
    intent: 'charge',
    steps: [
      'Select beat and license scope',
      'Initiate MPP charge',
      'Write memo-linked license proof',
      'Unlock secure stream/download URL',
    ],
  },
}

const extraFlowCopy: Record<
  ExtraFlowKey,
  { title: string; subtitle: string; intent: 'charge' | 'session'; steps: string[]; endpoint: string }
> = {
  'judge-score': {
    title: 'Judge Score Submission',
    subtitle: 'Capture accountable score writes for rounds with receipt-backed auditability.',
    intent: 'charge',
    steps: [
      'Open judge score console for battle round',
      'Submit score write with paid API call',
      'Verify score receipt and immutable record',
      'Publish score to battle timeline',
    ],
    endpoint: 'POST /api/judges/score',
  },
  'cypher-micropot': {
    title: 'Cypher Micropot Sponsorship',
    subtitle: 'Accumulate fan micro-contributions in a live cypher support pot.',
    intent: 'session',
    steps: [
      'Open cypher pot for active dancer',
      'Send micropot contribution tick',
      'Confirm updated pot total in telemetry',
      'Use final pot snapshot for payout logic',
    ],
    endpoint: 'POST /api/cypher/micropot/contribute',
  },
  'clip-sale': {
    title: 'Clip Rights Revenue Router',
    subtitle: 'Settle clip sales and split proceeds between dancer, filmer, and organizer.',
    intent: 'charge',
    steps: [
      'Prepare clip sale order and split shares',
      'Execute clip sale settlement call',
      'Verify settlement receipt and split record',
      'Store rights event for reporting and payouts',
    ],
    endpoint: 'POST /api/clips/sale',
  },
  reputation: {
    title: 'Reputation Passport Attestation',
    subtitle: 'Issue trust badges from verified issuers into dancer reputation history.',
    intent: 'charge',
    steps: [
      'Select issuer and dancer reputation claim',
      'Write attestation through paid endpoint',
      'Confirm reputation receipt and badge type',
      'Publish updated profile trust signal',
    ],
    endpoint: 'POST /api/reputation/attest',
  },
  'ai-usage': {
    title: 'Studio AI Usage Billing',
    subtitle: 'Track and bill studio AI choreography or feedback tool usage.',
    intent: 'charge',
    steps: [
      'Capture studio tool usage event',
      'Send metered billing usage call',
      'Verify usage receipt and event id',
      'Append billing event to cost timeline',
    ],
    endpoint: 'POST /api/studio/ai-usage',
  },
  'bot-action': {
    title: 'Tournament Ops Bot Action',
    subtitle:
      'Monetize and audit event-day automation actions for bracket operations, then notify staff via AgentMail.',
    intent: 'charge',
    steps: [
      'Pick event action to automate',
      'Dispatch bot action via paid endpoint',
      'Verify bot receipt and action queue id',
      'Send operations alert via AgentMail',
    ],
    endpoint: 'POST /api/bot/action',
  },
  'fan-pass': {
    title: 'Fan Battle Pass Purchase',
    subtitle: 'Issue paid fan memberships with gated perks and receipt proofs.',
    intent: 'charge',
    steps: [
      'Select fan membership tier',
      'Submit battle pass purchase call',
      'Verify pass id and purchase receipt',
      'Enable gated perks for active pass holder',
    ],
    endpoint: 'POST /api/fan-pass/purchase',
  },
  'virtual-card': {
    title: 'Virtual Debit Card Creation',
    subtitle: 'Issue a funded virtual debit card tied to wallet-based payment rails.',
    intent: 'charge',
    steps: [
      'Select wallet and top-up amount',
      'Create virtual debit card intent',
      'Receive card number, expiry, and CVV',
      'Store receipt and card telemetry',
    ],
    endpoint: 'POST /api/card/create',
  },
  'travel-logistics': {
    title: 'Event Travel Logistics (StableTravel)',
    subtitle: 'Query flights for dancers/judges using StableTravel pay-per-request travel APIs.',
    intent: 'charge',
    steps: [
      'Set origin, destination, and event date',
      'Call StableTravel flight search via backend',
      'Handle x402/MPP challenge or parse offers',
      'Store selected itinerary for event ops',
    ],
    endpoint: 'POST /api/travel/stable/flights-search',
  },
  'flight-tracking': {
    title: 'Flight Tracking (Aviationstack)',
    subtitle:
      'Track real-time or historical flight status for dancer, judge, and crew travel operations.',
    intent: 'charge',
    steps: [
      'Set flight IATA or route filters',
      'Call Aviationstack flights endpoint via backend',
      'Parse live status and schedule fields',
      'Attach status insight to event operations timeline',
    ],
    endpoint: 'POST /api/travel/aviationstack/flights',
  },
  'geo-routing': {
    title: 'Venue Geocoding (Google Maps)',
    subtitle:
      'Resolve venue addresses to coordinates for travel ops, dispatch timing, and event logistics mapping.',
    intent: 'charge',
    steps: [
      'Set venue address input for event ops',
      'Call Google Maps geocode endpoint via backend',
      'Resolve coordinates and formatted address',
      'Attach venue map coordinates to operations timeline',
    ],
    endpoint: 'POST /api/travel/googlemaps/geocode',
  },
  'sneaker-intel': {
    title: 'Sneaker Market Intel (KicksDB)',
    subtitle:
      'Query sneaker pricing and product metadata for fan perks, merch drops, and battle pass activation strategies.',
    intent: 'charge',
    steps: [
      'Set SKU or product query for campaign',
      'Call KicksDB search endpoint via backend',
      'Parse product and market pricing signals',
      'Attach insights to fan pass and merch planning',
    ],
    endpoint: 'POST /api/market/kicksdb/search',
  },
  'weather-ops': {
    title: 'Weather Ops Intel (OpenWeather)',
    subtitle:
      'Fetch live weather conditions for event venues to support battle scheduling, transport timing, and safety planning.',
    intent: 'charge',
    steps: [
      'Set venue coordinates for event location',
      'Call OpenWeather current endpoint via backend',
      'Parse conditions, temperature, and wind signals',
      'Attach weather risk notes to operations timeline',
    ],
    endpoint: 'POST /api/travel/openweather/current',
  },
  'suno-beatgen': {
    title: 'AI Beat Generation (Suno)',
    subtitle:
      'Generate event-ready beat concepts for licensing and promo clips using paid Suno music generation APIs.',
    intent: 'charge',
    steps: [
      'Set beat generation prompt and style',
      'Call Suno generation endpoint via backend',
      'Receive generated track metadata/output',
      'Attach generated beat to licensing workflow',
    ],
    endpoint: 'POST /api/music/suno/generate',
  },
  'voice-ops': {
    title: 'Voice Ops Calls (StablePhone)',
    subtitle:
      'Trigger AI phone calls for tournament operations (call-time reminders, judge check-ins, and urgent logistics).',
    intent: 'charge',
    steps: [
      'Set destination phone number and ops task',
      'Call StablePhone via backend proxy',
      'Handle x402/MPP challenge or call initiation response',
      'Persist call id for transcript/status polling',
    ],
    endpoint: 'POST /api/ops/stablephone/call',
  },
  'social-intel': {
    title: 'Social Intel Scrape (StableSocial)',
    subtitle:
      'Collect social profile signals for dancer/fan growth and campaign planning using pay-per-request social intelligence.',
    intent: 'charge',
    steps: [
      'Set social target (e.g., Instagram username)',
      'Trigger StableSocial scrape job',
      'Poll job token for completion/data',
      'Attach social signals to fan and ops insights',
    ],
    endpoint: 'POST /api/social/stablesocial/instagram-profile',
  },
}

const payments = ['payment.authorized', 'payment.finalized', 'session.ticked', 'session.closed']
const apiSpec: Record<FlowKey, string[]> = {
  battle: [
    'POST /api/battle/entry',
    'POST /api/battle/result',
    'POST /api/payout/execute',
    'GET /api/payout/:battleId',
    'POST /api/ai/explain-flow',
  ],
  coaching: [
    'POST /api/coaching/start',
    'POST /api/coaching/ping-usage',
    'POST /api/coaching/end',
    'GET /api/coaching/:id/receipt',
  ],
  beats: ['POST /api/beats/:id/license-intent', 'POST /api/beats/:id/grant-access'],
}

const DEMO_BATTLE_ID = 'battle_demo'
const DEMO_DANCER_ID = 'dancer_1'
const DEMO_ENTRY_FEE = '12.00'
const DEMO_COACH_ID = 'coach_krump'
const DEMO_BEAT_ID = 'beat_krump_1'
const DEMO_CONSUMER_ID = 'consumer_1'

function App() {
  const [activeFlow, setActiveFlow] = useState<FlowKey>('battle')
  const [currentStep, setCurrentStep] = useState(0)
  const [sessionSeconds, setSessionSeconds] = useState(0)
  const [log, setLog] = useState<string[]>(['Demo initialized.'])
  const [flowError, setFlowError] = useState('')
  const [loading, setLoading] = useState(false)

  const [battleIntentId, setBattleIntentId] = useState('')
  const [tempoNetwork, setTempoNetwork] = useState<'testnet' | 'mainnet' | null>(null)

  const [showExtraPanel, setShowExtraPanel] = useState(false)
  const [activeExtraFlow, setActiveExtraFlow] = useState<ExtraFlowKey>('judge-score')
  const [extraStep, setExtraStep] = useState(0)
  const [extraStatus, setExtraStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [extraSummary, setExtraSummary] = useState('—')
  const [extraError, setExtraError] = useState('')
  const [extraLog, setExtraLog] = useState<string[]>([])
  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>(() => listTxHistory())
  const [manualTxHash, setManualTxHash] = useState('')
  const [manualTxNetwork, setManualTxNetwork] = useState<TxNetwork>('testnet')
  const [manualTxFlow, setManualTxFlow] = useState<TxFlow>('battle')

  const flow = flowCopy[activeFlow]
  const extraFlow = extraFlowCopy[activeExtraFlow]

  const parseResponse = async (res: Response) => {
    const text = await res.text()
    try {
      return { data: text ? JSON.parse(text) : null, text }
    } catch {
      return { data: null, text }
    }
  }

  const pushLog = (msg: string) => setLog((prev) => [msg, ...prev].slice(0, 8))
  const refreshTxHistory = () => setTxHistory(listTxHistory())
  const addManualTx = () => {
    const tx = manualTxHash.trim()
    if (!tx) return
    addTxHistory({
      hash: tx,
      network: manualTxNetwork,
      flow: manualTxFlow,
    })
    setManualTxHash('')
    refreshTxHistory()
  }

  const resetFlow = (key: FlowKey) => {
    setActiveFlow(key)
    setCurrentStep(0)
    setSessionSeconds(0)
    setFlowError('')
    pushLog(`Switched to ${flowCopy[key].title}.`)
  }

  const callBattle = async (step: number) => {
    const base = { battleId: DEMO_BATTLE_ID, dancerId: DEMO_DANCER_ID }
    if (step === 1) {
      const res = await fetch('/api/battle/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, amountDisplay: DEMO_ENTRY_FEE }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'Entry failed')
      setBattleIntentId(data.intentId)
      setTempoNetwork(data.testnet ? 'testnet' : 'mainnet')
      pushLog('Entry intent created.')
      return
    }
    if (step === 2) {
      const res = await fetch('/api/battle/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, intentId: battleIntentId, simulatePayment: true }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'Payment finalize failed')
      pushLog('Payment finalized.')
      return
    }
    if (step === 3) {
      const res = await fetch('/api/battle/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battleId: DEMO_BATTLE_ID,
          winners: [{ dancerId: DEMO_DANCER_ID, amountDisplay: '30.00' }],
        }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'Finalize failed')
      pushLog('Results finalized.')
      return
    }
    if (step === 4) {
      const res = await fetch('/api/payout/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ battleId: DEMO_BATTLE_ID }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'Payout failed')
      pushLog('Payout executed.')
    }
  }

  const callCoaching = async (step: number) => {
    if (step === 1) {
      const res = await fetch('/api/coaching/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coachId: DEMO_COACH_ID, dancerId: DEMO_DANCER_ID, ratePerMinute: 2.5 }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'Session start failed')
      pushLog('Coaching session started.')
      return
    }
    if (step === 2) {
      setSessionSeconds((s) => s + 30)
      pushLog('Coaching usage metered (+30s).')
      return
    }
    if (step === 3) {
      pushLog('Coaching session ended.')
    }
  }

  const callBeats = async (step: number) => {
    if (step === 2) {
      const res = await fetch(`/api/beats/${DEMO_BEAT_ID}/license-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumerId: DEMO_CONSUMER_ID, amountDisplay: DEMO_ENTRY_FEE }),
      })
      const { data } = await parseResponse(res)
      if (!res.ok) throw new Error(data?.error || 'License intent failed')
      pushLog('Beat license intent created.')
      return
    }
    if (step === 3) {
      pushLog('Beat license granted.')
    }
  }

  const advance = async () => {
    if (currentStep >= flow.steps.length - 1) return
    const next = currentStep + 1
    setLoading(true)
    setFlowError('')
    try {
      if (activeFlow === 'battle') await callBattle(next)
      if (activeFlow === 'coaching') await callCoaching(next)
      if (activeFlow === 'beats') await callBeats(next)
      setCurrentStep(next)
      pushLog(`Step ${next + 1}: ${flow.steps[next]}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setFlowError(msg)
      pushLog(`API error: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const runExtra = async (kind: ExtraFlowKey) => {
    setLoading(true)
    setExtraError('')
    setExtraStatus('idle')
    try {
      if (kind === 'judge-score') {
        const res = await fetch('/api/judges/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ battleId: DEMO_BATTLE_ID, roundId: 'round_1', judgeId: 'judge_1', dancerId: DEMO_DANCER_ID, score: 8.7 }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'Judge score failed')
        setExtraSummary(`Score receipt: ${data.receipt.externalId}`)
      } else if (kind === 'cypher-micropot') {
        const res = await fetch('/api/cypher/micropot/contribute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cypherId: 'cypher_demo', dancerId: DEMO_DANCER_ID, amount: 1 }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'Micropot failed')
        setExtraSummary(`Cypher total: ${data.total}`)
      } else if (kind === 'clip-sale') {
        const res = await fetch('/api/clips/sale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clipId: 'clip_1',
            buyerId: 'buyer_1',
            totalAmount: 25,
            splits: [
              { recipientId: DEMO_DANCER_ID, share: 0.5 },
              { recipientId: 'filmer_1', share: 0.3 },
              { recipientId: 'organizer_1', share: 0.2 },
            ],
          }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'Clip sale failed')
        setExtraSummary(`Clip sale: ${data.saleId}`)
      } else if (kind === 'reputation') {
        const res = await fetch('/api/reputation/attest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issuerId: 'event_1', dancerId: DEMO_DANCER_ID, type: 'battle_winner', eventId: 'event_1' }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'Reputation failed')
        setExtraSummary(`Badge: ${data.type}`)
      } else if (kind === 'ai-usage') {
        const res = await fetch('/api/studio/ai-usage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studioId: 'studio_1', toolId: 'ai_feedback', units: 1, mode: 'charge' }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'AI usage failed')
        setExtraSummary(`Usage event: ${data.id}`)
      } else if (kind === 'bot-action') {
        const res = await fetch('/api/bot/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event_1', actionType: 'call_time_alert', payload: { battleId: DEMO_BATTLE_ID } }),
        })
        const { data } = await parseResponse(res)
        if (!res.ok) throw new Error(data?.error || 'Bot action failed')
        const mailRes = await fetch('/api/ops/agentmail/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inbox_id: AGENTMAIL_DEMO_INBOX_ID,
            to: 'ops@dancetech.finance',
            subject: `Ops Alert: ${data.actionType}`,
            text: `Event ${data.eventId} action ${data.actionType} executed at ${data.createdAt}.`,
          }),
        })
        const { data: mailData } = await parseResponse(mailRes)
        if (!mailRes.ok) throw new Error(mailData?.error || mailData?.details || 'AgentMail alert failed')
        setExtraSummary(`Bot action + AgentMail alert sent`)
      } else {
        if (kind === 'fan-pass') {
          const res = await fetch('/api/fan-pass/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fanId: 'fan_1', tier: 'battle_pass' }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) throw new Error(data?.error || 'Fan pass failed')
          setExtraSummary(`Pass: ${data.passId}`)
        } else if (kind === 'virtual-card') {
          const res = await fetch('/api/card/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletAddress: '0x610876De73cD9F8F925Fd3f84903d25be6f0921d',
              amountDisplay: '5.00',
              currency: 'USD',
              label: 'Krump Battle Card',
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) throw new Error(data?.error || 'Virtual card creation failed')
          setExtraSummary(`Card: ${data.cardId}`)
        } else if (kind === 'travel-logistics') {
          const res = await fetch('/api/travel/stable/flights-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              originLocationCode: 'JFK',
              destinationLocationCode: 'LAX',
              departureDate: '2026-07-10',
              adults: 1,
              max: 3,
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'StableTravel flight search failed')
          }
          const offers = Array.isArray(data?.result?.data) ? data.result.data.length : 0
          setExtraSummary(`StableTravel offers: ${offers}`)
        } else if (kind === 'flight-tracking') {
          const res = await fetch('/api/travel/aviationstack/flights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              flight_iata: 'AA100',
              flight_status: 'active',
              limit: 3,
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'Aviationstack lookup failed')
          }
          const flights = Array.isArray(data?.result?.data) ? data.result.data.length : 0
          setExtraSummary(`Aviationstack flights: ${flights}`)
        } else if (kind === 'geo-routing') {
          const res = await fetch('/api/travel/googlemaps/geocode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              address: '1600 Amphitheatre Parkway, Mountain View, CA',
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'Google Maps geocode failed')
          }
          const first = Array.isArray(data?.result?.results) ? data.result.results[0] : null
          const loc = first?.geometry?.location
          if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            setExtraSummary(`Google Maps geocode: ${loc.lat}, ${loc.lng}`)
          } else {
            const count = Array.isArray(data?.result?.results) ? data.result.results.length : 0
            setExtraSummary(`Google Maps geocode results: ${count}`)
          }
        } else if (kind === 'sneaker-intel') {
          const res = await fetch('/api/market/kicksdb/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: 'Nike Dunk',
              market: 'US',
              per_page: 3,
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'KicksDB search failed')
          }
          const items = Array.isArray(data?.result?.data) ? data.result.data.length : 0
          setExtraSummary(`KicksDB products: ${items}`)
        } else if (kind === 'weather-ops') {
          const res = await fetch('/api/travel/openweather/current', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lat: 34.0522,
              lon: -118.2437,
              units: 'metric',
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'OpenWeather lookup failed')
          }
          const temp = data?.result?.main?.temp
          const condition = Array.isArray(data?.result?.weather) ? data.result.weather[0]?.main : null
          if (temp != null || condition) {
            setExtraSummary(`OpenWeather: ${condition || 'Condition n/a'} ${temp != null ? `(${temp})` : ''}`)
          } else {
            setExtraSummary('OpenWeather response received')
          }
        } else if (kind === 'suno-beatgen') {
          const res = await fetch('/api/music/suno/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: 'Aggressive krump battle beat, 100 bpm, dark bass, crowd energy',
              style: 'krump',
              duration: 30,
              customMode: false,
              instrumental: true,
              model: 'V5',
            }),
          })
          const { data } = await parseResponse(res)
          if (!res.ok) {
            throw new Error(data?.error || data?.details || 'Suno generation failed')
          }
          const id =
            data?.result?.id ||
            data?.result?.track_id ||
            data?.result?.jobId ||
            data?.result?.job_id ||
            null
          setExtraSummary(id ? `Suno job: ${id}` : 'Suno generation response received')
        } else if (kind === 'voice-ops') {
          const callRes = await fetch('/api/ops/stablephone/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone_number: '+14155551234',
              task: 'Call and remind crew call-time is 6pm sharp. Keep it concise and professional.',
              voice: 'natdefault',
            }),
          })
          const { data } = await parseResponse(callRes)
          if (!callRes.ok) {
            throw new Error(data?.error || data?.details || 'StablePhone call failed')
          }
          const callId = data?.result?.call_id || data?.result?.id || data?.result?.callId || null
          setExtraSummary(callId ? `StablePhone call: ${callId}` : 'StablePhone call started')
        } else {
          const triggerRes = await fetch('/api/social/stablesocial/instagram-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'nike' }),
          })
          const { data } = await parseResponse(triggerRes)
          if (!triggerRes.ok) {
            throw new Error(data?.error || data?.details || 'StableSocial trigger failed')
          }
          const token = data?.result?.token || data?.result?.job_token || null
          if (!token) {
            setExtraSummary('StableSocial trigger complete (no token returned)')
          } else {
            const pollRes = await fetch(`/api/social/stablesocial/jobs?token=${encodeURIComponent(token)}`)
            const { data: pollData } = await parseResponse(pollRes)
            if (!pollRes.ok) {
              throw new Error(pollData?.error || pollData?.details || 'StableSocial poll failed')
            }
            const status = pollData?.result?.status || 'unknown'
            setExtraSummary(`StableSocial job: ${status}`)
          }
        }
      }
      setExtraStatus('ok')
      setExtraLog((prev) => [`Executed ${extraFlowCopy[kind].title}.`, ...prev].slice(0, 8))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setExtraStatus('error')
      setExtraError(msg)
      setExtraLog((prev) => [`API error: ${msg}`, ...prev].slice(0, 8))
    } finally {
      setLoading(false)
    }
  }

  const advanceExtra = async () => {
    const next = Math.min(extraStep + 1, extraFlow.steps.length - 1)
    if (next === 1) await runExtra(activeExtraFlow)
    setExtraStep(next)
  }

  const resetExtra = (key: ExtraFlowKey) => {
    setActiveExtraFlow(key)
    setExtraStep(0)
    setExtraStatus('idle')
    setExtraSummary('—')
    setExtraError('')
    setExtraLog((prev) => [`Switched to ${extraFlowCopy[key].title}.`, ...prev].slice(0, 8))
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>Krump DanceTech Demo</h1>
        <p>Foundational interface across all 10 DanceTech Finance use cases.</p>
        <div className="flow-switch">
          {(['battle', 'coaching', 'beats'] as FlowKey[]).map((key) => (
            <button
              key={key}
              className={!showExtraPanel && activeFlow === key ? 'active' : ''}
              onClick={() => {
                setShowExtraPanel(false)
                resetFlow(key)
              }}
            >
              {flowCopy[key].title}
            </button>
          ))}
          <button className={showExtraPanel ? 'active' : ''} onClick={() => setShowExtraPanel(true)}>
            Extra Use Case APIs
          </button>
          <a className="secondary" href="/dance-extras" style={{ padding: '0.5rem 0.75rem', borderRadius: 8 }}>
            7 flows (testnet/mainnet page)
          </a>
        </div>
      </header>

      {showExtraPanel ? (
        <section className="grid">
          <article className="card">
            <h2>Extra Use Case API Demos</h2>
            <p>
              Quick API demos from the hub (multi-step). The <strong>seven DanceTech</strong> flows (judge → fan pass)
              also have a dedicated <a href="/dance-extras">/dance-extras</a> page with <strong>simulate vs live Tempo MPP</strong>.
              Card, travel, kicks, weather, etc. have their own routes — see links at the bottom of the hub.
            </p>
            <div className="extra-action-grid">
              {(Object.keys(extraFlowCopy) as ExtraFlowKey[]).map((key) => (
                <button key={key} className={activeExtraFlow === key ? 'active' : ''} onClick={() => resetExtra(key)}>
                  {extraFlowCopy[key].title}
                </button>
              ))}
            </div>
            <p className="intent">
              Payment intent: <strong>{extraFlow.intent}</strong>
            </p>
            <p>{extraFlow.subtitle}</p>
            <ol>
              {extraFlow.steps.map((step, idx) => (
                <li key={step} className={idx <= extraStep ? 'done' : ''}>
                  {step}
                </li>
              ))}
            </ol>
            <div className="actions">
              <button onClick={advanceExtra} disabled={loading || extraStep >= extraFlow.steps.length - 1}>
                {loading ? 'Calling API...' : extraStep >= extraFlow.steps.length - 1 ? 'Flow Completed' : 'Next Step'}
              </button>
              <button className="secondary" onClick={() => resetExtra(activeExtraFlow)}>
                Restart
              </button>
            </div>
          </article>

          <article className="card">
            <h3>Extra Use Case Telemetry</h3>
            <ul className="meta">
              <li>
                <span>Status</span>
                <strong>{extraStatus}</strong>
              </li>
              <li>
                <span>Summary</span>
                <strong>{extraSummary}</strong>
              </li>
            </ul>
            {extraError ? <p className="error">{extraError}</p> : null}
            <h4>Webhook events</h4>
            <div className="chips">
              {payments.map((event) => (
                <code key={event}>{event}</code>
              ))}
            </div>
            <h4>Latest actions</h4>
            <ul className="log">
              {extraLog.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </article>
        </section>
      ) : (
        <section className="grid">
          <article className="card">
            <h2>{flow.title}</h2>
            <p>{flow.subtitle}</p>
            <p className="intent">
              Payment intent: <strong>{flow.intent}</strong>
            </p>
            <ol>
              {flow.steps.map((step, idx) => (
                <li key={step} className={idx <= currentStep ? 'done' : ''}>
                  {step}
                </li>
              ))}
            </ol>
            <div className="actions">
              <button onClick={advance} disabled={loading || currentStep >= flow.steps.length - 1}>
                {loading ? 'Calling API...' : currentStep >= flow.steps.length - 1 ? 'Flow Completed' : 'Next Step'}
              </button>
              <button className="secondary" onClick={() => resetFlow(activeFlow)}>
                Restart
              </button>
            </div>
          </article>

          <article className="card">
            <h3>Live Demo Telemetry</h3>
            <ul className="meta">
              <li>
                <span>Status</span>
                <strong>{currentStep === flow.steps.length - 1 ? 'finalized' : 'in_progress'}</strong>
              </li>
              <li>
                <span>Receipt</span>
                <strong>
                  {activeFlow === 'coaching'
                    ? `$${Math.max(1, Math.floor(sessionSeconds / 60)) * 2.5} stablecoin`
                    : `$${DEMO_ENTRY_FEE} stablecoin`}
                </strong>
              </li>
              {tempoNetwork ? (
                <li>
                  <span>Tempo</span>
                  <strong>{tempoNetwork}</strong>
                </li>
              ) : null}
              <li>
                <span>Session seconds</span>
                <strong>{sessionSeconds}s</strong>
              </li>
            </ul>
            {flowError ? <p className="error">{flowError}</p> : null}
            <h4>Webhook events</h4>
            <div className="chips">
              {payments.map((event) => (
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
      )}

      <section className="card api">
        <h3>Backend API Contract Preview</h3>
        <div className="api-list">
          {(showExtraPanel
            ? [extraFlow.endpoint]
            : apiSpec[activeFlow]
          ).map((endpoint) => (
            <code key={endpoint}>{endpoint}</code>
          ))}
        </div>
      </section>

      <section className="card api">
        <h3>Dedicated Battle Frontend</h3>
        <p>
          Open <code>/battle</code> for focused testnet/mainnet Battle Entry + Auto Payout
          testing.
        </p>
        <p>
          Open <code>/coaching</code> for a dedicated Coaching Minutes flow and <code>/beats</code>{' '}
          for dedicated Beat API Licensing flow.
        </p>
        <p>
          Open <code>/dance-extras</code> for the seven other core DanceTech scaffolds (judge, cypher, clips,
          reputation, studio AI, bot, fan pass) with <strong>testnet/mainnet</strong> on each API call.
        </p>
        <p>
          Open <code>/card</code> for dedicated virtual debit card creation.
        </p>
        <p>
          Open <code>/travel</code> for dedicated StableTravel, Aviationstack, and Google Maps ops testing.
        </p>
        <p>
          Open <code>/email</code> for dedicated AgentMail notification testing.
        </p>
        <p>
          Open <code>/ops</code> for a combined AgentMail + StablePhone operations console.
        </p>
        <p>
          Open <code>/social</code> for StableSocial trigger + token polling tests.
        </p>
        <p>
          Open <code>/music</code> for Suno music generation tests.
        </p>
        <p>
          Open <code>/parallel</code> for Parallel web search / extract / task (MPP on Tempo mainnet).
        </p>
        <p>
          Open <code>/weather</code> for OpenWeather current conditions (MPP on Tempo mainnet).
        </p>
        <p>
          Open <code>/openai</code> for OpenAI chat completions via MPP (<code>openai.mpp.tempo.xyz</code>).
        </p>
        <p>
          Open <code>/anthropic</code> for Claude (Messages API + OpenAI-compatible chat) via MPP (
          <code>anthropic.mpp.tempo.xyz</code>).
        </p>
        <p>
          Open <code>/openrouter</code> for OpenRouter unified chat via MPP (<code>openrouter.mpp.tempo.xyz</code>).
        </p>
        <p>
          Open <code>/perplexity</code> for Perplexity Sonar / search / embeddings via MPP (
          <code>perplexity.mpp.tempo.xyz</code>).
        </p>
        <p>
          Open <code>/alchemy</code> for Alchemy JSON-RPC + NFT API v3 via MPP (<code>mpp.alchemy.com</code>).
        </p>
        <p>
          Open <code>/fal</code> for fal.ai image / video / audio models via MPP (<code>fal.mpp.tempo.xyz</code>).
        </p>
        <p>
          Open <code>/replicate</code> for Replicate model runs / predictions via MPP (
          <code>replicate.mpp.paywithlocus.com</code>).
        </p>
        <p>
          Open <code>/kicks</code> for dedicated KicksDB market intelligence tests.
        </p>
        <p>
          Open <code>/tip20</code> for dedicated TIP-20 token launch testing.
        </p>
      </section>

      <section className="card api">
        <h3>Global Transaction History</h3>
        <p>Relevant live transactions recorded across testnet and mainnet.</p>
        <div className="actions">
          <input
            placeholder="Paste tx hash from explorer"
            value={manualTxHash}
            onChange={(e) => setManualTxHash(e.target.value)}
          />
          <select
            value={manualTxNetwork}
            onChange={(e) => setManualTxNetwork(e.target.value === 'mainnet' ? 'mainnet' : 'testnet')}
          >
            <option value="testnet">testnet</option>
            <option value="mainnet">mainnet</option>
          </select>
          <select
            value={manualTxFlow}
            onChange={(e) => setManualTxFlow((e.target.value as TxFlow) || 'battle')}
          >
            <option value="battle">battle</option>
            <option value="coaching">coaching</option>
            <option value="beats">beats</option>
            <option value="email">email</option>
          </select>
          <button className="secondary" onClick={addManualTx} disabled={!manualTxHash.trim()}>
            Add Transaction
          </button>
        </div>
        <div className="actions">
          <button className="secondary" onClick={refreshTxHistory}>
            Refresh
          </button>
          <button
            className="secondary"
            onClick={() => {
              clearTxHistory()
              refreshTxHistory()
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
                  {tx.hash.slice(0, 10)}...{tx.hash.slice(-6)}
                </a>
              </li>
            ))
          )}
        </ul>
      </section>
    </main>
  )
}

export default App
