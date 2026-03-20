/**
 * The seven DanceTech flows that live on the hub (and `/dance-extras`) alongside the three
 * dedicated pages: Battle, Coaching, Beats — see README and DANCETECH_USE_CASES.md.
 */
export type CoreExtraFlowKey =
  | 'judge-score'
  | 'cypher-micropot'
  | 'clip-sale'
  | 'reputation'
  | 'ai-usage'
  | 'bot-action'
  | 'fan-pass'

export const CORE_EXTRA_FLOW_ORDER: CoreExtraFlowKey[] = [
  'judge-score',
  'cypher-micropot',
  'clip-sale',
  'reputation',
  'ai-usage',
  'bot-action',
  'fan-pass',
]

export const coreExtraFlowCopy: Record<
  CoreExtraFlowKey,
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
}
