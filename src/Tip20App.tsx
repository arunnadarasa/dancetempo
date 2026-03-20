import { useEffect, useMemo, useState } from 'react'
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from 'viem'
import { type BrowserEthereumProvider, tempoBrowserWalletTransport } from './tempoMpp'
import { writeContract } from 'viem/actions'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import { Abis, Addresses, tempoActions, withFeePayer } from 'viem/tempo'
import './App.css'

const shortValue = (value: string, keep = 26) => {
  if (!value) return value
  if (value.length <= keep) return value
  return `${value.slice(0, keep)}...`
}

const shortHash = (value: string) => {
  if (!value || value.length < 14) return value
  return `${value.slice(0, 10)}...${value.slice(-6)}`
}

const toHexChainId = (id: number) => `0x${id.toString(16)}`

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Unknown error'
}

const isGasLimitTooHighError = (err: unknown) =>
  getErrorMessage(err).toLowerCase().includes('gas limit too high')

const isInsufficientFundsForGasError = (err: unknown) =>
  getErrorMessage(err).toLowerCase().includes('insufficient funds for gas')

type Network = 'testnet' | 'mainnet'
type LaunchItem = {
  launchId: string
  network: Network
  name: string
  symbol: string
  decimals: number
  totalSupply: number
  ownerAddress: string
  factoryAddress: string
  tokenAddress: string
  status: string
  createdAt: string
  deployTxHash?: string
  mintTxHash?: string
  salt?: string
  receipt?: { externalId?: string; reference?: string }
}

export default function Tip20App() {
  const [network, setNetwork] = useState<Network>('testnet')
  const [sponsoredFeesEnabled, setSponsoredFeesEnabled] = useState(false)
  const [name, setName] = useState('Krump USD')
  const [symbol, setSymbol] = useState('KRUMPUSD')
  const [decimals, setDecimals] = useState('6')
  const [totalSupply, setTotalSupply] = useState('1000000')
  const [ownerAddress, setOwnerAddress] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [currencyCode, setCurrencyCode] = useState('USD')
  const [quoteTokenAddress, setQuoteTokenAddress] = useState(Addresses.pathUsd)
  type FeeTokenPreset = 'custom' | 'stargate_usdc_e' | 'pathUSD' | 'alphaUSD' | 'betaUSD' | 'thetaUSD'
  const [feeTokenPreset, setFeeTokenPreset] = useState<FeeTokenPreset>('custom')
  const [feeTokenForWrites, setFeeTokenForWrites] = useState('')

  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [launchId, setLaunchId] = useState('')
  const [factoryAddress, setFactoryAddress] = useState(Addresses.tip20Factory)
  const [tokenAddress, setTokenAddress] = useState('')
  const [deployTxHash, setDeployTxHash] = useState('')
  const [mintTxHash, setMintTxHash] = useState('')
  const [saltHex, setSaltHex] = useState('')
  const [verifyContractId, setVerifyContractId] = useState('src/MyToken.sol:MyToken')
  const [receiptRef, setReceiptRef] = useState('')
  const [launches, setLaunches] = useState<LaunchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [verificationCheckStatus, setVerificationCheckStatus] = useState<
    'unknown' | 'verified' | 'not_verified' | 'error'
  >('unknown')
  const [verificationCheckDetails, setVerificationCheckDetails] = useState('')
  const [opsTokenAddress, setOpsTokenAddress] = useState('')
  const [opsIssuerAddress, setOpsIssuerAddress] = useState('')
  const [opsMintRecipient, setOpsMintRecipient] = useState('')
  const [opsMintAmount, setOpsMintAmount] = useState('1000')
  const [opsMintDecimals, setOpsMintDecimals] = useState('6')
  const [opsGrantTxHash, setOpsGrantTxHash] = useState('')
  const [opsMintTxHash, setOpsMintTxHash] = useState('')
  const [opsIssuerRoleStatus, setOpsIssuerRoleStatus] = useState<'unknown' | 'has' | 'missing'>('unknown')
  const [feeUserToken, setFeeUserToken] = useState('')
  const [feeValidatorToken, setFeeValidatorToken] = useState('')
  const [feeValidatorAmount, setFeeValidatorAmount] = useState('100')
  const [feeDecimals, setFeeDecimals] = useState('6')
  const [feeToAddress, setFeeToAddress] = useState('')
  const [feeApproveTxHash, setFeeApproveTxHash] = useState('')
  const [feeMintTxHash, setFeeMintTxHash] = useState('')
  const [feeReserveUser, setFeeReserveUser] = useState('')
  const [feeReserveValidator, setFeeReserveValidator] = useState('')
  const [feeLpSupply, setFeeLpSupply] = useState('')
  const [feeTokenBalance, setFeeTokenBalance] = useState('')
  const [feeTokenBalanceStatus, setFeeTokenBalanceStatus] = useState<'unknown' | 'ok' | 'error'>('unknown')
  const [feePreferenceTxHash, setFeePreferenceTxHash] = useState('')
  const [feePreferenceStatus, setFeePreferenceStatus] = useState<'idle' | 'set' | 'error'>('idle')
  const [tokenlistLogoUri, setTokenlistLogoUri] = useState('')
  const [projectWebsite, setProjectWebsite] = useState('')
  const [projectDescription, setProjectDescription] = useState('Krump USD stablecoin on Tempo.')
  const [log, setLog] = useState<string[]>([
    'TIP-20 launcher initialized. Configure token metadata and launch.',
  ])

  const pushLog = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 12))
  const chainId = network === 'mainnet' ? 4217 : 42431
  const rpcUrl = network === 'mainnet' ? 'https://rpc.tempo.xyz' : 'https://rpc.moderato.tempo.xyz'
  const explorerBase = network === 'mainnet' ? 'https://explore.tempo.xyz/tx/' : 'https://explore.testnet.tempo.xyz/tx/'
  const usdcQuoteToken = network === 'mainnet'
    ? '0x20c000000000000000000000b9537d11c60e8b50'
    : '0x20c0000000000000000000000000000000000000'

  const bridgedUsdcFeeTokenMainnet = '0x20c000000000000000000000b9537d11c60e8b50'
  const sponsorUrl = 'https://sponsor.moderato.tempo.xyz'
  const sponsoredFees = sponsoredFeesEnabled && network === 'testnet'

  // Tempo testnet faucet assets (requesting the faucet funds all four).
  const alphaUsdFeeToken = '0x20c0000000000000000000000000000000000001'
  const betaUsdFeeToken = '0x20c0000000000000000000000000000000000002'
  const thetaUsdFeeToken = '0x20c0000000000000000000000000000000000003'

  const [faucetLoading, setFaucetLoading] = useState(false)
  const [faucetMessage, setFaucetMessage] = useState('')

  const getWalletTransport = () => {
    if (!window.ethereum) throw new Error('Wallet not found.')
    const defaultTransport = tempoBrowserWalletTransport(
      window.ethereum as BrowserEthereumProvider,
      rpcUrl,
    )
    return sponsoredFees
      ? withFeePayer(defaultTransport, http(sponsorUrl), { policy: 'sign-only' })
      : defaultTransport
  }

  const feeTokenOverride = feeTokenForWrites.trim()
  const feeTokenOverrideValid = /^0x[a-fA-F0-9]{40}$/.test(feeTokenOverride)
  // Avoid passing `feeToken` per-transaction (can break envelope encoding).
  // Instead, pin the fee token on the Tempo chain used by the wallet client.
  const feeTokenOverrideObj = {}

  const tempoChainWithFeeToken = <T extends typeof tempoModerato | typeof tempoMainnet>(
    baseChain: T,
  ) => {
    if (sponsoredFeesEnabled) return baseChain
    if (!feeTokenOverrideValid) return baseChain
    if (network !== 'mainnet') return baseChain
    // Chain type-casting: `feeToken` is Tempo-specific and not always present in generic
    // viem chain typings, so we treat `extend` as accepting `{ feeToken: string }`.
    return (baseChain as unknown as { extend: (args: { feeToken: string }) => T }).extend({
      feeToken: feeTokenOverride.toLowerCase(),
    })
  }

  const registryAssetUrl = tokenAddress
    ? `https://tokenlist.tempo.xyz/asset/${chainId}/${tokenAddress}`
    : ''
  const registryIconUrl = tokenAddress
    ? `https://tokenlist.tempo.xyz/icon/${chainId}/${tokenAddress}`
    : ''
  const registryListUrl = `https://tokenlist.tempo.xyz/list/${chainId}`
  const tokenSnippet = tokenAddress
    ? `{
  "name": "${name}",
  "symbol": "${symbol}",
  "decimals": ${Number(decimals || 18)},
  "chainId": ${chainId},
  "address": "${tokenAddress.toLowerCase()}"
}`
    : 'Launch a token first to generate a tokenlist JSON snippet.'
  const tokenlistSubmissionSnippet = tokenAddress
    ? `{
  "name": "${name}",
  "symbol": "${symbol}",
  "decimals": ${Number(decimals || 6)},
  "chainId": ${chainId},
  "address": "${tokenAddress.toLowerCase()}",
  "logoURI": "${tokenlistLogoUri || `https://tokenlist.tempo.xyz/icon/${chainId}/${tokenAddress.toLowerCase()}`}",
  "extensions": {
    "website": "${projectWebsite || 'https://example.com'}",
    "description": "${projectDescription || 'Tempo stablecoin'}"
  }
}`
    : 'Launch a token first to generate tokenlist submission payload.'

  const verifyCommand = useMemo(() => {
    if (!tokenAddress) return 'Launch token first to generate Foundry verify command.'
    return `forge verify-contract \\
  --verifier-url https://contracts.tempo.xyz \\
  --chain ${chainId} \\
  ${tokenAddress} \\
  ${verifyContractId}`
  }, [chainId, tokenAddress, verifyContractId])

  const verificationSubmitCurl = useMemo(() => {
    if (!tokenAddress) return 'Launch token first to generate API verify request.'
    return `curl -X POST https://contracts.tempo.xyz/v2/verify/${chainId}/${tokenAddress} \\
  -H 'Content-Type: application/json' \\
  -d '{
    "stdJsonInput": {
      "language": "Solidity",
      "sources": {
        "src/MyToken.sol": { "content": "// your full source" }
      },
      "settings": {
        "optimizer": { "enabled": false, "runs": 200 },
        "evmVersion": "cancun"
      }
    },
    "compilerVersion": "0.8.20+commit.a1b79de6",
    "contractIdentifier": "${verifyContractId}"
  }'`
  }, [chainId, tokenAddress, verifyContractId])

  const checkVerificationStatus = async () => {
    setVerificationCheckStatus('unknown')
    setVerificationCheckDetails('')
    setError('')
    try {
      if (!tokenAddress) throw new Error('Launch a token first.')
      const url = `https://contracts.tempo.xyz/v2/contract/${chainId}/${tokenAddress}`
      const res = await fetch(url)
      if (res.status === 404) {
        setVerificationCheckStatus('not_verified')
        setVerificationCheckDetails('Not verified (contract not found / not verified).')
        return
      }
      if (!res.ok) {
        const raw = await res.text()
        setVerificationCheckStatus('error')
        setVerificationCheckDetails(raw || `HTTP ${res.status}`)
        return
      }

      const data = await res.json().catch(() => null)
      setVerificationCheckStatus('verified')
      setVerificationCheckDetails(
        data?.verificationId
          ? `Verified (verificationId: ${data.verificationId}).`
          : 'Verified.'
      )
    } catch (err) {
      const message = getErrorMessage(err)
      setVerificationCheckStatus('error')
      setVerificationCheckDetails(message)
    }
  }

  const checkFeeTokenBalance = async () => {
    setFeeTokenBalanceStatus('unknown')
    setFeeTokenBalance('')
    setError('')
    try {
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!feeTokenForWrites || !feeTokenOverrideValid) throw new Error('Fee token address is required.')
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })
      const decimalsCount = await publicClient.readContract({
        address: feeTokenForWrites as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'decimals',
      })
      const bal = await publicClient.readContract({
        address: feeTokenForWrites as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'balanceOf',
        args: [walletAddress as `0x${string}`],
      })
      const formatted = formatUnits(bal, Number(decimalsCount))
      setFeeTokenBalance(formatted)
      setFeeTokenBalanceStatus('ok')
      pushLog(`Fee token balance: ${formatted}`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      setFeeTokenBalanceStatus('error')
      pushLog(`Fee token balance check failed: ${message}`)
    }
  }

  const setFeeTokenPreference = async () => {
    setLoading(true)
    setError('')
    setFeePreferenceStatus('idle')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!feeTokenForWrites || !feeTokenOverrideValid) throw new Error('Fee token address is required.')

      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      // Important: `FeeManager.setUserToken` is gated by `onlyDirectCall` (msg.sender == tx.origin).
      // Using the plain writeContract path (not sendCallsSync) keeps this as a direct EOA tx.
      const walletClient = createWalletClient({
        chain: selectedChain,
        transport: tempoBrowserWalletTransport(
          window.ethereum as BrowserEthereumProvider,
          rpcUrl,
        ),
        account: walletAddress as `0x${string}`,
      })

      const txHash = await writeContract(walletClient, {
        address: Addresses.feeManager,
        abi: Abis.feeManager,
        functionName: 'setUserToken',
        args: [feeTokenForWrites as `0x${string}`],
      })

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') throw new Error('Setting fee token preference reverted.')

      setFeePreferenceTxHash(txHash)
      setFeePreferenceStatus('set')
      pushLog(`Fee preference set to: ${shortValue(feeTokenForWrites, 18)}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      setFeePreferenceStatus('error')
      pushLog(`Set fee token preference failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setQuoteTokenAddress(usdcQuoteToken)
  }, [usdcQuoteToken])

  useEffect(() => {
    // For mainnet, default the fee token override to bridged USDC (currency="USD") so
    // "insufficient funds for gas" is resolved without manual configuration.
    if (network === 'mainnet' && !feeTokenForWrites) {
      setFeeTokenPreset('stargate_usdc_e')
      setFeeTokenForWrites(bridgedUsdcFeeTokenMainnet)
    }
  }, [network, feeTokenForWrites])

  useEffect(() => {
    if (feeTokenPreset === 'custom') return
    if (feeTokenPreset === 'stargate_usdc_e') setFeeTokenForWrites(bridgedUsdcFeeTokenMainnet)
    if (feeTokenPreset === 'pathUSD') setFeeTokenForWrites(Addresses.pathUsd)
    if (feeTokenPreset === 'alphaUSD' && network !== 'mainnet') setFeeTokenForWrites(alphaUsdFeeToken)
    if (feeTokenPreset === 'betaUSD' && network !== 'mainnet') setFeeTokenForWrites(betaUsdFeeToken)
    if (feeTokenPreset === 'thetaUSD' && network !== 'mainnet') setFeeTokenForWrites(thetaUsdFeeToken)
  }, [feeTokenPreset, network])

  useEffect(() => {
    // Alpha/Beta/Theta are not offered on Tempo mainnet to reduce confusion.
    if (
      network === 'mainnet' &&
      (feeTokenPreset === 'alphaUSD' || feeTokenPreset === 'betaUSD' || feeTokenPreset === 'thetaUSD')
    ) {
      setFeeTokenPreset('stargate_usdc_e')
      setFeeTokenForWrites(bridgedUsdcFeeTokenMainnet)
    }
  }, [network, feeTokenPreset])

  useEffect(() => {
    if (tokenAddress) setOpsTokenAddress(tokenAddress)
  }, [tokenAddress])

  useEffect(() => {
    if (!opsIssuerAddress && ownerAddress) setOpsIssuerAddress(ownerAddress)
    if (!opsMintRecipient && ownerAddress) setOpsMintRecipient(ownerAddress)
  }, [ownerAddress, opsIssuerAddress, opsMintRecipient])

  useEffect(() => {
    if (tokenAddress) setFeeUserToken(tokenAddress)
    setFeeValidatorToken(usdcQuoteToken)
  }, [tokenAddress, usdcQuoteToken])

  useEffect(() => {
    if (!feeToAddress && ownerAddress) setFeeToAddress(ownerAddress)
  }, [feeToAddress, ownerAddress])

  const connectWallet = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[]
      if (!accounts?.length) throw new Error('No wallet account returned.')
      const account = accounts[0]
      setWalletAddress(account)
      if (!ownerAddress) setOwnerAddress(account)
      pushLog(`Wallet connected: ${shortValue(account, 20)}`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Connect wallet failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const requestTempoTestnetFaucet = async () => {
    setFaucetLoading(true)
    setFaucetMessage('')
    try {
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (network !== 'testnet') throw new Error('Faucet is available on Tempo testnet only.')

      // Proxied through the backend to avoid browser CORS issues.
      const res = await fetch('/api/tempo/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress.toLowerCase() }),
      })

      const raw = await res.text()
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }

      if (!res.ok) {
        const details = data?.details || data?.error || raw
        throw new Error(`Tempo faucet failed (${res.status}): ${String(details || 'unknown error')}`)
      }

      setFaucetMessage('Faucet requested. Wait a moment, then refresh your wallet balances.')
      pushLog('Tempo testnet faucet requested (path/Alpha/Beta/Theta).')
    } catch (err) {
      const message = getErrorMessage(err)
      setFaucetMessage(message)
      pushLog(`Faucet request failed: ${message}`)
    } finally {
      setFaucetLoading(false)
    }
  }

  const ensureSelectedWalletNetwork = async () => {
    if (!window.ethereum) throw new Error('Wallet not found.')
    const target = network === 'mainnet' ? tempoMainnet : tempoModerato
    const chainIdHex = toHexChainId(target.id)
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    } catch (err) {
      const e = err as { code?: number }
      if (e?.code !== 4902) throw err
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: target.name,
            nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
            rpcUrls: [rpcUrl],
            blockExplorerUrls: [
              network === 'mainnet' ? 'https://explore.tempo.xyz' : 'https://explore.testnet.tempo.xyz',
            ],
          },
        ],
      })
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    }
  }

  const launchToken = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!ownerAddress || !ownerAddress.startsWith('0x')) {
        throw new Error('Owner address is required.')
      }
      if (!quoteTokenAddress || !quoteTokenAddress.startsWith('0x')) {
        throw new Error('Quote token address is required.')
      }
      if (!name.trim() || !symbol.trim()) throw new Error('Name and symbol are required.')
      const decimalCount = Number(decimals)
      if (!Number.isInteger(decimalCount) || decimalCount < 0 || decimalCount > 30) {
        throw new Error('Decimals must be an integer between 0 and 30.')
      }

      await ensureSelectedWalletNetwork()
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const selectedChainWithFeeToken = tempoChainWithFeeToken(selectedChain)
      const walletClient = createWalletClient({
        chain: selectedChainWithFeeToken,
        transport: getWalletTransport(),
        account: walletAddress as `0x${string}`,
      }).extend(tempoActions())
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const salt =
        `0x${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16).padStart(64, '0')}` as `0x${string}`
      const predictedAddress = await publicClient.readContract({
        address: Addresses.tip20Factory,
        abi: Abis.tip20Factory,
        functionName: 'getTokenAddress',
        args: [walletAddress as `0x${string}`, salt],
      })

      const createArgs = {
        address: Addresses.tip20Factory,
        abi: Abis.tip20Factory,
        functionName: 'createToken',
        args: [
          name,
          symbol,
          currencyCode.trim().toUpperCase() || 'USD',
          quoteTokenAddress as `0x${string}`,
          ownerAddress as `0x${string}`,
          salt,
        ],
        account: walletAddress as `0x${string}`,
      } as const
      let createHash: `0x${string}` | undefined
      try {
        createHash = await writeContract(walletClient, {
          ...createArgs,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      } catch (err) {
        if (network === 'mainnet' && isInsufficientFundsForGasError(err)) {
          // FeeManager collects `maxAmount = gasLimit * gasPrice` before execution.
          // If the wallet can't reserve enough fee-token for that max fee, reduce `gas`.
          const gasCandidates = [120000n, 90000n, 70000n, 50000n, 40000n]
          let lastErr: unknown = err
          for (const gas of gasCandidates) {
            try {
              createHash = await writeContract(walletClient, {
                ...createArgs,
                gas,
                ...(sponsoredFees ? { feePayer: true } : {}),
                ...feeTokenOverrideObj,
              })
              lastErr = undefined
              break
            } catch (e) {
              lastErr = e
              if (!isInsufficientFundsForGasError(e)) throw e
            }
          }
          if (!createHash && lastErr) throw lastErr
        } else if (isGasLimitTooHighError(err)) {
          createHash = await writeContract(walletClient, {
            ...createArgs,
            gas: 300000n,
            ...(sponsoredFees ? { feePayer: true } : {}),
            ...feeTokenOverrideObj,
          })
        } else {
          throw err
        }
      }

      if (!createHash) throw new Error('Create token tx hash missing after retries.')
      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
      if (createReceipt.status !== 'success') throw new Error('Create token transaction reverted.')

      const mintAmount = parseUnits(totalSupply || '0', decimalCount)
      let mintedHash: `0x${string}` | undefined
      let mintSucceeded = true

      if (mintAmount > 0n) {
        const mintArgs = {
          address: predictedAddress,
          abi: Abis.tip20,
          functionName: 'mint',
          args: [ownerAddress as `0x${string}`, mintAmount],
          account: walletAddress as `0x${string}`,
        } as const
        try {
          mintedHash = await writeContract(walletClient, {
            ...mintArgs,
            ...(sponsoredFees ? { feePayer: true } : {}),
            ...feeTokenOverrideObj,
          })
        } catch (err) {
          if (network === 'mainnet' && isInsufficientFundsForGasError(err)) {
            // Mint is typically cheaper than createToken; try a descending gas ladder.
            const gasCandidates = [80000n, 60000n, 45000n, 35000n]
            let lastErr: unknown = err
            for (const gas of gasCandidates) {
              try {
                mintedHash = await writeContract(walletClient, {
                  ...mintArgs,
                  gas,
                  ...(sponsoredFees ? { feePayer: true } : {}),
                  ...feeTokenOverrideObj,
                })
                lastErr = undefined
                break
              } catch (e) {
                lastErr = e
                if (!isInsufficientFundsForGasError(e)) throw e
              }
            }
            if (!mintedHash && lastErr) throw lastErr
          } else if (isGasLimitTooHighError(err)) {
            mintedHash = await writeContract(walletClient, {
              ...mintArgs,
              gas: 300000n,
              ...(sponsoredFees ? { feePayer: true } : {}),
              ...feeTokenOverrideObj,
            })
          } else {
            throw err
          }
        }
        if (!mintedHash) throw new Error('Mint tx hash missing after retries.')
        const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintedHash })
        mintSucceeded = mintReceipt.status === 'success'
      }

      const now = new Date().toISOString()
      const id = `tip20-${Date.now()}`
      const record: LaunchItem = {
        launchId: id,
        network,
        name,
        symbol,
        decimals: decimalCount,
        totalSupply: Number(totalSupply),
        ownerAddress,
        factoryAddress: Addresses.tip20Factory,
        tokenAddress: predictedAddress,
        status: mintSucceeded ? 'deployed' : 'mint_failed',
        createdAt: now,
        deployTxHash: createHash,
        mintTxHash: mintedHash,
        salt,
      }

      setStatus(mintSucceeded ? 'ok' : 'error')
      setLaunchId(id)
      setFactoryAddress(Addresses.tip20Factory)
      setTokenAddress(predictedAddress)
      setDeployTxHash(createHash)
      setMintTxHash(mintedHash || '')
      setSaltHex(salt)
      setReceiptRef(createHash)
      setLaunches((prev) => [record, ...prev].slice(0, 40))
      pushLog(`Token created on ${network}: ${symbol} -> ${shortValue(predictedAddress, 20)}`)
      if (mintedHash) {
        pushLog(`Initial mint submitted: ${shortHash(mintedHash)}`)
        if (!mintSucceeded) {
          const mintMessage = 'Token created, but initial mint reverted. Grant ISSUER_ROLE, then mint from Post-Launch Ops.'
          setError(mintMessage)
          pushLog(mintMessage)
        }
      } else {
        pushLog('Initial mint skipped because total supply is 0.')
      }
    } catch (err) {
      const message = getErrorMessage(err)
      setStatus('error')
      setError(message)
      pushLog(`Launch failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const grantIssuerRole = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!opsTokenAddress || !opsTokenAddress.startsWith('0x')) throw new Error('Token address is required.')
      if (!opsIssuerAddress || !opsIssuerAddress.startsWith('0x')) throw new Error('Issuer address is required.')

      await ensureSelectedWalletNetwork()
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const selectedChainWithFeeToken = tempoChainWithFeeToken(selectedChain)
      const walletClient = createWalletClient({
        chain: selectedChainWithFeeToken,
        transport: getWalletTransport(),
        account: walletAddress as `0x${string}`,
      }).extend(tempoActions())
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const issuerRole = await publicClient.readContract({
        address: opsTokenAddress as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'ISSUER_ROLE',
      })

      const grantArgs = {
        address: opsTokenAddress as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'grantRole',
        args: [issuerRole, opsIssuerAddress as `0x${string}`],
        account: walletAddress as `0x${string}`,
      } as const
      let txHash: `0x${string}`
      try {
        txHash = await writeContract(walletClient, {
          ...grantArgs,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      } catch (err) {
        if (!isGasLimitTooHighError(err)) throw err
        txHash = await writeContract(walletClient, {
          ...grantArgs,
          gas: 300000n,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      }

      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setOpsGrantTxHash(txHash)
      pushLog(`ISSUER_ROLE granted to ${shortValue(opsIssuerAddress, 20)}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Grant issuer failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const mintMore = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!opsTokenAddress || !opsTokenAddress.startsWith('0x')) throw new Error('Token address is required.')
      if (!opsMintRecipient || !opsMintRecipient.startsWith('0x')) throw new Error('Mint recipient is required.')
      const decimalsCount = Number(opsMintDecimals)
      if (!Number.isInteger(decimalsCount) || decimalsCount < 0 || decimalsCount > 30) {
        throw new Error('Mint decimals must be an integer between 0 and 30.')
      }
      const mintAmount = parseUnits(opsMintAmount || '0', decimalsCount)
      if (mintAmount <= 0n) throw new Error('Mint amount must be greater than 0.')

      await ensureSelectedWalletNetwork()
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const selectedChainWithFeeToken = tempoChainWithFeeToken(selectedChain)
      const walletClient = createWalletClient({
        chain: selectedChainWithFeeToken,
        transport: getWalletTransport(),
        account: walletAddress as `0x${string}`,
      }).extend(tempoActions())
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const mintArgs = {
        address: opsTokenAddress as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'mint',
        args: [opsMintRecipient as `0x${string}`, mintAmount],
        account: walletAddress as `0x${string}`,
      } as const
      let txHash: `0x${string}` | undefined
      try {
        txHash = await writeContract(walletClient, {
          ...mintArgs,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      } catch (err) {
        if (network === 'mainnet' && isInsufficientFundsForGasError(err)) {
          const gasCandidates = [80000n, 60000n, 45000n, 35000n]
          let lastErr: unknown = err
          for (const gas of gasCandidates) {
            try {
              txHash = await writeContract(walletClient, {
                ...mintArgs,
                gas,
                ...(sponsoredFees ? { feePayer: true } : {}),
                ...feeTokenOverrideObj,
              })
              lastErr = undefined
              break
            } catch (e) {
              lastErr = e
              if (!isInsufficientFundsForGasError(e)) throw e
            }
          }
          if (!txHash && lastErr) throw lastErr
        } else if (isGasLimitTooHighError(err)) {
          txHash = await writeContract(walletClient, {
            ...mintArgs,
            gas: 300000n,
            ...(sponsoredFees ? { feePayer: true } : {}),
            ...feeTokenOverrideObj,
          })
        } else {
          throw err
        }
      }

      if (!txHash) throw new Error('Mint tx hash missing after retries.')
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setOpsMintTxHash(txHash)
      pushLog(`Minted ${opsMintAmount} to ${shortValue(opsMintRecipient, 20)}.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Mint failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const approveFeeLiquiditySpend = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!feeValidatorToken || !feeValidatorToken.startsWith('0x')) throw new Error('Validator token address is required.')
      const decimalsCount = Number(feeDecimals)
      if (!Number.isInteger(decimalsCount) || decimalsCount < 0 || decimalsCount > 30) {
        throw new Error('Fee decimals must be an integer between 0 and 30.')
      }
      const amount = parseUnits(feeValidatorAmount || '0', decimalsCount)
      if (amount <= 0n) throw new Error('Validator token amount must be greater than 0.')

      await ensureSelectedWalletNetwork()
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const selectedChainWithFeeToken = tempoChainWithFeeToken(selectedChain)
      const walletClient = createWalletClient({
        chain: selectedChainWithFeeToken,
        transport: getWalletTransport(),
        account: walletAddress as `0x${string}`,
      }).extend(tempoActions())
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const approveArgs = {
        address: feeValidatorToken as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'approve',
        args: [Addresses.feeManager, amount],
        account: walletAddress as `0x${string}`,
      } as const
      let txHash: `0x${string}`
      try {
        txHash = await writeContract(walletClient, {
          ...approveArgs,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      } catch (err) {
        if (!isGasLimitTooHighError(err)) throw err
        txHash = await writeContract(walletClient, {
          ...approveArgs,
          gas: 300000n,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      }

      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setFeeApproveTxHash(txHash)
      pushLog(`Approved ${feeValidatorAmount} validator-token spend to FeeManager.`)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Approve fee-liquidity spend failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const addFeeLiquidity = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.ethereum) throw new Error('Wallet not found.')
      if (!walletAddress) throw new Error('Connect wallet first.')
      if (!feeUserToken || !feeUserToken.startsWith('0x')) throw new Error('User token address is required.')
      if (!feeValidatorToken || !feeValidatorToken.startsWith('0x')) throw new Error('Validator token address is required.')
      if (!feeToAddress || !feeToAddress.startsWith('0x')) throw new Error('LP recipient address is required.')
      const decimalsCount = Number(feeDecimals)
      if (!Number.isInteger(decimalsCount) || decimalsCount < 0 || decimalsCount > 30) {
        throw new Error('Fee decimals must be an integer between 0 and 30.')
      }
      const amount = parseUnits(feeValidatorAmount || '0', decimalsCount)
      if (amount <= 0n) throw new Error('Validator token amount must be greater than 0.')

      await ensureSelectedWalletNetwork()
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const selectedChainWithFeeToken = tempoChainWithFeeToken(selectedChain)
      const walletClient = createWalletClient({
        chain: selectedChainWithFeeToken,
        transport: getWalletTransport(),
        account: walletAddress as `0x${string}`,
      }).extend(tempoActions())
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const mintArgs = {
        address: Addresses.feeManager,
        abi: Abis.feeAmm,
        functionName: 'mint',
        args: [feeUserToken as `0x${string}`, feeValidatorToken as `0x${string}`, amount, feeToAddress as `0x${string}`],
        account: walletAddress as `0x${string}`,
      } as const
      let txHash: `0x${string}`
      try {
        txHash = await writeContract(walletClient, {
          ...mintArgs,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      } catch (err) {
        if (!isGasLimitTooHighError(err)) throw err
        txHash = await writeContract(walletClient, {
          ...mintArgs,
          gas: 500000n,
          ...(sponsoredFees ? { feePayer: true } : {}),
          ...feeTokenOverrideObj,
        })
      }

      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setFeeMintTxHash(txHash)
      pushLog('Fee liquidity added successfully.')
      await refreshFeePool()
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Add fee liquidity failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const refreshFeePool = async () => {
    setLoading(true)
    setError('')
    try {
      if (!feeUserToken || !feeUserToken.startsWith('0x')) throw new Error('User token address is required.')
      if (!feeValidatorToken || !feeValidatorToken.startsWith('0x')) throw new Error('Validator token address is required.')
      const decimalsCount = Number(feeDecimals)
      if (!Number.isInteger(decimalsCount) || decimalsCount < 0 || decimalsCount > 30) {
        throw new Error('Fee decimals must be an integer between 0 and 30.')
      }
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })
      const pool = await publicClient.readContract({
        address: Addresses.feeManager,
        abi: Abis.feeAmm,
        functionName: 'getPool',
        args: [feeUserToken as `0x${string}`, feeValidatorToken as `0x${string}`],
      })
      const totalSupply = await publicClient.readContract({
        address: Addresses.feeManager,
        abi: Abis.feeAmm,
        functionName: 'totalSupply',
        args: [await publicClient.readContract({
          address: Addresses.feeManager,
          abi: Abis.feeAmm,
          functionName: 'getPoolId',
          args: [feeUserToken as `0x${string}`, feeValidatorToken as `0x${string}`],
        })],
      })
      setFeeReserveUser(formatUnits(pool.reserveUserToken, decimalsCount))
      setFeeReserveValidator(formatUnits(pool.reserveValidatorToken, decimalsCount))
      setFeeLpSupply(formatUnits(totalSupply, decimalsCount))
      pushLog('Fee pool reserves refreshed.')
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Refresh fee pool failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const checkIssuerRole = async () => {
    setLoading(true)
    setError('')
    try {
      if (!opsTokenAddress || !opsTokenAddress.startsWith('0x')) throw new Error('Token address is required.')
      if (!opsIssuerAddress || !opsIssuerAddress.startsWith('0x')) throw new Error('Issuer address is required.')
      const selectedChain = network === 'mainnet' ? tempoMainnet : tempoModerato
      const publicClient = createPublicClient({
        chain: selectedChain,
        transport: http(rpcUrl),
      })

      const issuerRole = await publicClient.readContract({
        address: opsTokenAddress as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'ISSUER_ROLE',
      })
      const hasRole = await publicClient.readContract({
        address: opsTokenAddress as `0x${string}`,
        abi: Abis.tip20,
        functionName: 'hasRole',
        args: [opsIssuerAddress as `0x${string}`, issuerRole],
      })
      const ok = Boolean(hasRole)
      setOpsIssuerRoleStatus(ok ? 'has' : 'missing')
      pushLog(ok ? 'Issuer role check: address has ISSUER_ROLE.' : 'Issuer role check: address is missing ISSUER_ROLE.')
    } catch (err) {
      const message = getErrorMessage(err)
      setError(message)
      pushLog(`Issuer role check failed: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const setStablecoinDefaults = () => {
    setName('Krump USD')
    setSymbol('KRUMPUSD')
    setDecimals('6')
    setCurrencyCode('USD')
    setQuoteTokenAddress(usdcQuoteToken)
    pushLog('Applied stablecoin defaults (USD + network quote token).')
  }

  const copyText = async (value: string, label: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      pushLog(`${label} copied.`)
    } catch {
      pushLog(`Copy failed for ${label}.`)
    }
  }

  return (
    <main className="app">
      <header className="hero">
        <h1>TIP-20 Stablecoin Launcher</h1>
        <p>Dedicated frontend to create + mint TIP-20 stablecoins on Tempo testnet/mainnet.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Launch Controls</h2>
          <p>
            Stablecoin mode only: use ISO 4217 for currency (for USD-denominated tokens, use <code>USD</code>).
          </p>
          <div className="field-grid">
            <label>
              Network
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value === 'mainnet' ? 'mainnet' : 'testnet')}
                disabled={loading}
              >
                <option value="testnet">Tempo testnet</option>
                <option value="mainnet">Tempo mainnet</option>
              </select>
            </label>
            <label>
              Wallet
              <input value={walletAddress} readOnly placeholder="Connect wallet first" />
            </label>
            <label>
              Token Name
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={loading} />
            </label>
            <label>
              Symbol
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Decimals (mint)
              <input value={decimals} onChange={(e) => setDecimals(e.target.value)} disabled={loading} />
            </label>
            <label>
              Total Supply (mint)
              <input value={totalSupply} onChange={(e) => setTotalSupply(e.target.value)} disabled={loading} />
            </label>
            <label>
              Owner Address
              <input value={ownerAddress} onChange={(e) => setOwnerAddress(e.target.value)} disabled={loading} />
            </label>
            <label>
              Currency (ISO 4217)
              <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} disabled={loading} />
            </label>
            <label>
              Quote Token Address
              <input value={quoteTokenAddress} onChange={(e) => setQuoteTokenAddress(e.target.value)} disabled={loading} />
            </label>
            <label>
              Fee Token (for gas)
              <select
                value={feeTokenPreset}
                onChange={(e) => setFeeTokenPreset(e.target.value as FeeTokenPreset)}
                disabled={loading}
              >
                <option value="stargate_usdc_e">Stargate USDC.e (recommended)</option>
                <option value="pathUSD">pathUSD</option>
                {network === 'mainnet' ? null : (
                  <>
                    <option value="alphaUSD">AlphaUSD</option>
                    <option value="betaUSD">BetaUSD</option>
                    <option value="thetaUSD">ThetaUSD</option>
                  </>
                )}
                <option value="custom">Custom</option>
              </select>
              <input
                value={feeTokenForWrites}
                onChange={(e) => setFeeTokenForWrites(e.target.value)}
                disabled={loading || feeTokenPreset !== 'custom'}
              />
              <p>
                Use a preset to avoid mistyped fee-token addresses. On mainnet, presets are required unless you enable sponsored fees.
              </p>
            </label>
          </div>
          {network === 'testnet' ? (
            <div className="api-list">
              <code>Tempo testnet faucet funds:</code>
              <code>{`pathUSD: ${Addresses.pathUsd}`}</code>
              <code>{`AlphaUSD: ${alphaUsdFeeToken}`}</code>
              <code>{`BetaUSD: ${betaUsdFeeToken}`}</code>
              <code>{`ThetaUSD: ${thetaUsdFeeToken}`}</code>
              <button
                className="secondary"
                onClick={requestTempoTestnetFaucet}
                disabled={faucetLoading || !walletAddress}
              >
                {faucetLoading ? 'Requesting...' : 'Request all 4 USD'}
              </button>
              {faucetMessage ? <p>{faucetMessage}</p> : null}
              <p>
                Faucet docs:{' '}
                <a href="https://docs.tempo.xyz/quickstart/faucet" target="_blank" rel="noreferrer">
                  docs.tempo.xyz/quickstart/faucet
                </a>
              </p>
            </div>
          ) : (
            <div className="api-list">
              <code>Tempo mainnet USDC.e (fee token):</code>
              <p>
                Acquire `USDC.e` via Stargate Finance, then keep Fee Token set to{' '}
                <code>Stargate USDC.e</code>.
              </p>
              <p>
                Stargate transfer docs:{' '}
                <a href="https://docs.stargate.finance/developers/tutorials/evm" target="_blank" rel="noreferrer">
                  EVM tutorial
                </a>
                {' · '}
                <a
                  href="https://docs.stargate.finance/developers/protocol-docs/transfer"
                  target="_blank"
                  rel="noreferrer"
                >
                  protocol transfer
                </a>
              </p>
            </div>
          )}
          <div className="actions">
            <button
              className="secondary"
              onClick={connectWallet}
              disabled={loading || !!walletAddress}
            >
              {walletAddress ? 'Wallet Connected' : 'Connect Wallet'}
            </button>
            <button className="secondary" onClick={setStablecoinDefaults} disabled={loading}>
              Apply Stablecoin Defaults
            </button>
            <button
              className="secondary"
              onClick={checkFeeTokenBalance}
              disabled={loading || !walletAddress || !feeTokenOverrideValid}
            >
              Check Fee Token Balance
            </button>
            <button
              className="secondary"
              onClick={setFeeTokenPreference}
              disabled={loading || !walletAddress || !feeTokenOverrideValid || feePreferenceStatus === 'set'}
            >
              {feePreferenceStatus === 'set' ? 'Fee Preference Set' : 'Set Fee Token Preference'}
            </button>
            <button
              onClick={launchToken}
              disabled={
                loading ||
                !walletAddress ||
                !ownerAddress ||
                !quoteTokenAddress ||
                (network === 'mainnet' && !sponsoredFees && !feeTokenOverrideValid)
              }
            >
              {loading ? 'Launching...' : 'Launch TIP-20 (create + mint)'}
            </button>
          </div>
          {feePreferenceTxHash ? (
            <p>
              Fee preference tx:{' '}
              <a
                href={`${explorerBase}${feePreferenceTxHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortHash(feePreferenceTxHash)}
              </a>
            </p>
          ) : null}
          {feeTokenBalanceStatus !== 'unknown' ? (
            <p>
              Fee token balance:{' '}
              <strong>
                {feeTokenBalanceStatus === 'ok' ? feeTokenBalance : 'Error'}
              </strong>
            </p>
          ) : null}
        </article>

        <article className="card">
          <h3>Live Demo Telemetry</h3>
          <ul className="meta">
            <li>
              <span>Status</span>
              <strong>{status}</strong>
            </li>
            <li>
              <span>Launch ID</span>
              <strong>{launchId ? shortValue(launchId) : '—'}</strong>
            </li>
            <li>
              <span>Factory</span>
              <strong>{factoryAddress ? shortValue(factoryAddress) : '—'}</strong>
            </li>
            <li>
              <span>Token</span>
              <strong>{tokenAddress ? shortValue(tokenAddress) : '—'}</strong>
            </li>
            <li>
              <span>Create Tx</span>
              <strong>{deployTxHash ? shortHash(deployTxHash) : '—'}</strong>
            </li>
            <li>
              <span>Mint Tx</span>
              <strong>{mintTxHash ? shortHash(mintTxHash) : '—'}</strong>
            </li>
            <li>
              <span>Salt</span>
              <strong>{saltHex ? shortValue(saltHex, 18) : '—'}</strong>
            </li>
            <li>
              <span>Receipt Ref</span>
              <strong>{receiptRef ? shortValue(receiptRef) : '—'}</strong>
            </li>
          </ul>
          {deployTxHash ? (
            <p>
              Create explorer: <a href={`${explorerBase}${deployTxHash}`} target="_blank" rel="noreferrer">{shortHash(deployTxHash)}</a>
            </p>
          ) : null}
          {mintTxHash ? (
            <p>
              Mint explorer: <a href={`${explorerBase}${mintTxHash}`} target="_blank" rel="noreferrer">{shortHash(mintTxHash)}</a>
            </p>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
          <h4>Latest actions</h4>
          <ul className="log">
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="card api">
        <h3>Recent Launches</h3>
        <ul className="log">
          {launches.length === 0 ? (
            <li>No TIP-20 launches yet.</li>
          ) : (
            launches.map((item) => (
              <li key={item.launchId}>
                {item.symbol} ({item.name}) - {item.network} - {shortValue(item.tokenAddress)} - supply {item.totalSupply}
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="card api">
        <h3>Generate Foundry Verify Command</h3>
        <label>
          Contract Identifier
          <input value={verifyContractId} onChange={(e) => setVerifyContractId(e.target.value)} disabled={loading} />
        </label>
        <div className="actions">
          <button className="secondary" onClick={() => copyText(verifyCommand, 'Foundry verify command')} disabled={!tokenAddress}>
            Copy Verify Command
          </button>
        </div>
        <pre className="ai-output">{verifyCommand}</pre>
      </section>

      <section className="card api">
        <h3>Contract Verification (Tempo)</h3>
        <p>After deployment, verify your contract so ABI/source appears in Tempo Explorer.</p>
        <div className="api-list">
          <code>Foundry: --verify --verifier-url https://contracts.tempo.xyz</code>
          <code>Hardhat Sourcify API: https://contracts.tempo.xyz</code>
          <code>REST: POST /v2/verify/{`{chainId}`}/{`{address}`}</code>
          <code>REST: GET /v2/verify/{`{verificationId}`}</code>
          <code>REST: GET /v2/contract/{`{chainId}`}/{`{address}`}</code>
        </div>
        <p>
          Supported chains: Mainnet <code>4217</code>, Testnet <code>42431</code>.
        </p>
        <p>
          Verification docs: <a href="https://contracts.tempo.xyz/docs" target="_blank" rel="noreferrer">contracts.tempo.xyz/docs</a>
        </p>
        <div className="actions">
          <button className="secondary" onClick={checkVerificationStatus} disabled={!tokenAddress || loading}>
            Check Verification Status
          </button>
        </div>
        {verificationCheckStatus !== 'unknown' ? (
          <p className={verificationCheckStatus === 'verified' ? 'ok' : 'error'}>
            Verification: <strong>{verificationCheckStatus === 'verified' ? 'Verified' : verificationCheckStatus === 'not_verified' ? 'Not Verified' : 'Error'}</strong>
            {verificationCheckDetails ? ` (${verificationCheckDetails})` : null}
          </p>
        ) : null}
      </section>

      <section className="card api">
        <h3>Verification API Templates</h3>
        <p>Dynamic request examples based on selected network and token telemetry.</p>
        <div className="api-list">
          <code>{`POST https://contracts.tempo.xyz/v2/verify/${chainId}/${tokenAddress || '{address}'}`}</code>
          <code>{`GET https://contracts.tempo.xyz/v2/verify/{verificationId}`}</code>
          <code>{`GET https://contracts.tempo.xyz/v2/contract/${chainId}/${tokenAddress || '{address}'}`}</code>
        </div>
        <pre className="ai-output">{verificationSubmitCurl}</pre>
      </section>

      <section className="card api">
        <h3>Network Details</h3>
        <div className="api-list">
          <code>{`Factory: ${Addresses.tip20Factory}`}</code>
          <code>{`Configured currency: ${currencyCode || 'USD'}`}</code>
          <code>{`Configured quote token: ${quoteTokenAddress}`}</code>
          <code>{`Recommended USDC quote token: ${usdcQuoteToken}`}</code>
          <code>{`pathUSD quote token: ${Addresses.pathUsd}`}</code>
          <code>{`Chain ID: ${chainId}`}</code>
          <code>{`RPC: ${rpcUrl}`}</code>
          <code>{`Explorer tx base: ${explorerBase}`}</code>
        </div>
      </section>

      <section className="card api">
        <h3>Sponsorship + Fee Notes</h3>
        <p>
          Optional: enable sponsored fees (testnet). When enabled, writes use Tempo hosted fee payer transport and set
          <code> feePayer: true</code>.
        </p>
        <div className="field-grid">
          <label>
            Enable Sponsored Fees (testnet only)
            <input
              type="checkbox"
              checked={sponsoredFeesEnabled}
              onChange={(e) => setSponsoredFeesEnabled(e.target.checked)}
              disabled={network !== 'testnet' || loading}
            />
          </label>
        </div>
        <div className="api-list">
          <code>Public testnet sponsor service: https://sponsor.moderato.tempo.xyz</code>
          <code>Use feeToken for non-sponsored custom fee token selection</code>
          <code>Sponsored txs require sender intent before signing</code>
        </div>
      </section>

      <section className="card api">
        <h3>Post-Launch Ops</h3>
        <p>Run common stablecoin operator actions after deploy: grant issuer and mint additional supply.</p>
        <div className="field-grid">
          <label>
            Token Address
            <input value={opsTokenAddress} onChange={(e) => setOpsTokenAddress(e.target.value)} disabled={loading} />
          </label>
          <label>
            Issuer Address (grant role)
            <input value={opsIssuerAddress} onChange={(e) => setOpsIssuerAddress(e.target.value)} disabled={loading} />
          </label>
          <label>
            Mint Recipient
            <input value={opsMintRecipient} onChange={(e) => setOpsMintRecipient(e.target.value)} disabled={loading} />
          </label>
          <label>
            Mint Amount
            <input value={opsMintAmount} onChange={(e) => setOpsMintAmount(e.target.value)} disabled={loading} />
          </label>
          <label>
            Mint Decimals
            <input value={opsMintDecimals} onChange={(e) => setOpsMintDecimals(e.target.value)} disabled={loading} />
          </label>
        </div>
        <div className="actions">
          <button className="secondary" onClick={checkIssuerRole} disabled={loading}>
            Check ISSUER_ROLE
          </button>
          <button className="secondary" onClick={grantIssuerRole} disabled={loading}>
            Grant ISSUER_ROLE
          </button>
          <button className="secondary" onClick={mintMore} disabled={loading}>
            Mint Additional Supply
          </button>
        </div>
        <p>
          Issuer role status:{' '}
          <strong>
            {opsIssuerRoleStatus === 'unknown'
              ? 'Not checked'
              : opsIssuerRoleStatus === 'has'
                ? 'Has ISSUER_ROLE'
                : 'Missing ISSUER_ROLE'}
          </strong>
        </p>
        {opsGrantTxHash ? (
          <p>
            Grant role tx: <a href={`${explorerBase}${opsGrantTxHash}`} target="_blank" rel="noreferrer">{shortHash(opsGrantTxHash)}</a>
          </p>
        ) : null}
        {opsMintTxHash ? (
          <p>
            Mint tx: <a href={`${explorerBase}${opsMintTxHash}`} target="_blank" rel="noreferrer">{shortHash(opsMintTxHash)}</a>
          </p>
        ) : null}
        <div className="api-list">
          <code>1) Create + mint stablecoin</code>
          <code>2) Add fee liquidity for fee conversions</code>
          <code>3) Optionally integrate sponsored fees for UX</code>
          <code>4) Monitor pool reserves and replenish</code>
        </div>
        <p>
          Guides: <a href="https://docs.tempo.xyz/guide/issuance/manage-stablecoin" target="_blank" rel="noreferrer">manage roles</a> ·{' '}
          <a href="https://docs.tempo.xyz/guide/stablecoin-dex/managing-fee-liquidity" target="_blank" rel="noreferrer">fee liquidity</a> ·{' '}
          <a href="https://docs.tempo.xyz/guide/payments/sponsor-user-fees" target="_blank" rel="noreferrer">sponsorship</a>
        </p>
      </section>

      <section className="card api">
        <h3>Fee Liquidity Wizard</h3>
        <p>Step through approve → add liquidity → check reserves for fee conversions.</p>
        <div className="field-grid">
          <label>
            User Token (your stablecoin)
            <input value={feeUserToken} onChange={(e) => setFeeUserToken(e.target.value)} disabled={loading} />
          </label>
          <label>
            Validator Token
            <input value={feeValidatorToken} onChange={(e) => setFeeValidatorToken(e.target.value)} disabled={loading} />
          </label>
          <label>
            Validator Token Amount
            <input value={feeValidatorAmount} onChange={(e) => setFeeValidatorAmount(e.target.value)} disabled={loading} />
          </label>
          <label>
            Decimals
            <input value={feeDecimals} onChange={(e) => setFeeDecimals(e.target.value)} disabled={loading} />
          </label>
          <label>
            LP Recipient (to)
            <input value={feeToAddress} onChange={(e) => setFeeToAddress(e.target.value)} disabled={loading} />
          </label>
        </div>
        <div className="actions">
          <button className="secondary" onClick={approveFeeLiquiditySpend} disabled={loading}>
            1) Approve Validator Token
          </button>
          <button className="secondary" onClick={addFeeLiquidity} disabled={loading}>
            2) Add Fee Liquidity
          </button>
          <button className="secondary" onClick={refreshFeePool} disabled={loading}>
            3) Refresh Pool Reserves
          </button>
        </div>
        {feeApproveTxHash ? (
          <p>
            Approve tx: <a href={`${explorerBase}${feeApproveTxHash}`} target="_blank" rel="noreferrer">{shortHash(feeApproveTxHash)}</a>
          </p>
        ) : null}
        {feeMintTxHash ? (
          <p>
            Liquidity mint tx: <a href={`${explorerBase}${feeMintTxHash}`} target="_blank" rel="noreferrer">{shortHash(feeMintTxHash)}</a>
          </p>
        ) : null}
        <div className="api-list">
          <code>{`Reserve user token: ${feeReserveUser || '—'}`}</code>
          <code>{`Reserve validator token: ${feeReserveValidator || '—'}`}</code>
          <code>{`LP total supply: ${feeLpSupply || '—'}`}</code>
        </div>
      </section>

      <section className="card api">
        <h3>Tokenlist Registry</h3>
        <p>Use Tempo tokenlist endpoints and submit your token metadata + icon PR after launch.</p>
        <div className="api-list">
          <code>{`GET ${registryListUrl}`}</code>
          <code>{`GET ${registryAssetUrl || 'https://tokenlist.tempo.xyz/asset/{chainId}/{address}'}`}</code>
          <code>{`GET ${registryIconUrl || 'https://tokenlist.tempo.xyz/icon/{chainId}/{address}'}`}</code>
        </div>
        <p>
          Tokenlist docs: <a href="https://docs.tempo.xyz/quickstart/tokenlist" target="_blank" rel="noreferrer">docs.tempo.xyz/quickstart/tokenlist</a>
        </p>
        <pre className="ai-output">{tokenSnippet}</pre>
      </section>

      <section className="card api">
        <h3>Tokenlist Submission Pack</h3>
        <p>Prepare metadata + icon links for your registry submission pull request.</p>
        <div className="field-grid">
          <label>
            Logo URI (optional)
            <input
              value={tokenlistLogoUri}
              onChange={(e) => setTokenlistLogoUri(e.target.value)}
              placeholder={tokenAddress ? `https://tokenlist.tempo.xyz/icon/${chainId}/${tokenAddress.toLowerCase()}` : 'Launch token first'}
              disabled={loading}
            />
          </label>
          <label>
            Project Website (optional)
            <input
              value={projectWebsite}
              onChange={(e) => setProjectWebsite(e.target.value)}
              placeholder="https://your-project-site"
              disabled={loading}
            />
          </label>
          <label>
            Description (optional)
            <input
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              disabled={loading}
            />
          </label>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => copyText(tokenlistSubmissionSnippet, 'Tokenlist metadata JSON')}
            disabled={!tokenAddress}
          >
            Copy Metadata JSON
          </button>
          <button
            className="secondary"
            onClick={() =>
              copyText(
                tokenAddress ? `https://tokenlist.tempo.xyz/icon/${chainId}/${tokenAddress.toLowerCase()}` : '',
                'Tokenlist icon URL template',
              )
            }
            disabled={!tokenAddress}
          >
            Copy Icon URL Template
          </button>
        </div>
        <div className="api-list">
          <code>{`Asset endpoint: https://tokenlist.tempo.xyz/asset/${chainId}/${tokenAddress || '{address}'}`}</code>
          <code>{`Icon endpoint: https://tokenlist.tempo.xyz/icon/${chainId}/${tokenAddress || '{address}'}`}</code>
          <code>Checklist: 1) metadata JSON 2) hosted icon 3) registry PR 4) verify asset endpoint</code>
        </div>
        <pre className="ai-output">{tokenlistSubmissionSnippet}</pre>
      </section>
    </main>
  )
}
