/**
 * Wallet-paid POST to /api/ops/agentmail/send (Tempo MPP).
 * Shared by Tip-20 launcher and similar flows; mirrors EmailApp live path.
 */
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import { createWalletClient } from 'viem'
import { tempoActions } from 'viem/tempo'
import { tempo as tempoMainnet, tempoModerato as tempoTestnet } from 'viem/chains'
import {
  type BrowserEthereumProvider,
  TEMPO_MPP_SESSION_MAX_DEPOSIT,
  tempoBrowserWalletTransport,
} from './tempoMpp'

export type AgentMailPaymentNetwork = 'testnet' | 'mainnet'

const tempoTestnetChain = tempoTestnet.extend({
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

function base64UrlDecode(value: string) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s + pad)
}

async function addTempoNetwork(target: AgentMailPaymentNetwork) {
  if (!window.ethereum) throw new Error('Wallet not found.')
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

async function ensureSelectedWalletNetwork(target: AgentMailPaymentNetwork) {
  if (!window.ethereum) throw new Error('Wallet not found.')
  const chain = target === 'testnet' ? tempoTestnetChain : tempoMainnetChain
  const chainIdHex = toHexChainId(chain.id)
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
  } catch (err: unknown) {
    const anyErr = err as { code?: number } | undefined
    if (anyErr?.code === 4902) {
      await addTempoNetwork(target)
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
      return
    }
    throw err
  }
}

async function ensureWalletTempoChainFromChallenge(
  wwwAuthenticate: string,
  allowTestnet: boolean,
): Promise<AgentMailPaymentNetwork | null> {
  const match = wwwAuthenticate.match(/request="([^"]+)"/)
  if (!match?.[1]) return null

  let decoded: unknown
  try {
    decoded = JSON.parse(base64UrlDecode(match[1]))
  } catch {
    return null
  }

  type ChallengeDecoded = { methodDetails?: { chainId?: unknown } }
  const chainId = (decoded as ChallengeDecoded | null | undefined)?.methodDetails?.chainId
  if (typeof chainId !== 'number') return null

  const target: AgentMailPaymentNetwork = chainId === tempoTestnetChain.id ? 'testnet' : 'mainnet'
  if (target === 'testnet' && !allowTestnet) {
    throw new Error('Tempo testnet is not enabled for AgentMail in this browser. Use mainnet or enable testnet in /email first.')
  }

  const chain = target === 'testnet' ? tempoTestnetChain : tempoMainnetChain
  const chainIdHex = toHexChainId(chain.id)

  try {
    await window.ethereum?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
  } catch (err: unknown) {
    const anyErr = err as { code?: number } | undefined
    if (anyErr?.code === 4902) {
      await addTempoNetwork(target)
      await window.ethereum?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    } else {
      throw err
    }
  }

  return target
}

export type AgentMailSendBody = {
  inbox_id: string
  to: string
  subject: string
  text?: string
  html?: string
  network: AgentMailPaymentNetwork
}

export async function postAgentMailSendWithMpp(
  walletAddress: string,
  initialPaymentNetwork: AgentMailPaymentNetwork,
  body: AgentMailSendBody,
): Promise<{ response: Response; paymentNetwork: AgentMailPaymentNetwork }> {
  if (!window.ethereum) throw new Error('Wallet not found.')
  const allowTestnet =
    typeof window !== 'undefined' && window.localStorage.getItem('agentmail_tempo_testnet_supported') === 'true'

  const requestInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }

  let resolvedNetwork: AgentMailPaymentNetwork = initialPaymentNetwork

  try {
    const pre = await fetch('/api/ops/agentmail/send', requestInit)
    if (pre.status === 402) {
      const www = pre.headers.get('www-authenticate') || ''
      const target = www ? await ensureWalletTempoChainFromChallenge(www, allowTestnet) : null
      if (target) resolvedNetwork = target
    }
  } catch {
    // ignore
  }

  await ensureSelectedWalletNetwork(resolvedNetwork)

  const chain = resolvedNetwork === 'testnet' ? tempoTestnetChain : tempoMainnetChain
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

  const url = '/api/ops/agentmail/send'

  try {
    const response = await makeMppx('push').fetch(url, requestInit)
    return { response, paymentNetwork: resolvedNetwork }
  } catch (pushErr) {
    const pushMessage = pushErr instanceof Error ? pushErr.message : String(pushErr)
    const lower = pushMessage.toLowerCase()
    const userRejected =
      lower.includes('user rejected') || lower.includes('user denied') || lower.includes('denied') || lower.includes('rejected')
    if (userRejected) throw new Error(`MetaMask push failed: ${pushMessage}`)

    const response = await makeMppx('pull').fetch(url, requestInit)
    return { response, paymentNetwork: resolvedNetwork }
  }
}
