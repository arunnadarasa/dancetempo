/** Grouped links for the main hub — every dedicated app route in one place. */

export type HubRoute = { href: string; title: string; hint: string }

export type HubRouteGroup = { label: string; routes: HubRoute[]; footnote?: string }

export const HUB_ROUTE_GROUPS: HubRouteGroup[] = [
  {
    label: 'Core DanceTech',
    routes: [
      { href: '/battle', title: 'Battle', hint: 'Entry + auto payout (full page)' },
      { href: '/coaching', title: 'Coaching', hint: 'Minutes marketplace' },
      { href: '/beats', title: 'Beats', hint: 'API licensing' },
      { href: '/dance-extras', title: '7 flows', hint: 'Simulate vs live MPP' },
    ],
  },
  {
    label: 'CLI & wire',
    routes: [
      { href: '/tempo-wallet', title: 'Tempo Wallet', hint: 'Official CLI + tempo request' },
      { href: '/purl', title: 'Stripe purl', hint: 'curl-style MPP dry-run' },
      { href: '/evvm', title: 'EVVM', hint: 'Deploy on Tempo testnet' },
    ],
    footnote:
      'Mainnet live MPP: plan for at least ~50 USDC on Tempo mainnet (gas/path fees + paid calls; exact minimum varies by route). Use testnet first.',
  },
  {
    label: 'Commerce & ops',
    routes: [
      { href: '/card', title: 'Card', hint: 'Virtual debit (Laso / MPP)' },
      { href: '/travel', title: 'Travel', hint: 'StableTravel, aviation, maps' },
      { href: '/kicks', title: 'Kicks', hint: 'KicksDB intel' },
      { href: '/tip20', title: 'TIP‑20', hint: 'NHS edu demo + Hospital XYZ token + AgentMail' },
      { href: '/email', title: 'Email', hint: 'AgentMail' },
      { href: '/ops', title: 'Ops', hint: 'AgentMail + StablePhone' },
    ],
  },
  {
    label: 'AI & data (MPP)',
    routes: [
      { href: '/social', title: 'Social', hint: 'StableSocial' },
      { href: '/music', title: 'Music', hint: 'Suno' },
      { href: '/parallel', title: 'Parallel', hint: 'Search / extract / task' },
      { href: '/weather', title: 'Weather', hint: 'OpenWeather' },
      { href: '/openai', title: 'OpenAI', hint: 'Chat via MPP gateway' },
      { href: '/anthropic', title: 'Anthropic', hint: 'Claude via MPP' },
      { href: '/openrouter', title: 'OpenRouter', hint: 'Unified chat' },
      { href: '/perplexity', title: 'Perplexity', hint: 'Sonar / search' },
      { href: '/alchemy', title: 'Alchemy', hint: 'RPC + NFT API' },
      { href: '/fal', title: 'fal.ai', hint: 'Image / video / audio' },
      { href: '/replicate', title: 'Replicate', hint: 'Model runs' },
    ],
  },
]
