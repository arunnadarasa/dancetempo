import './App.css'
import { DocCodeBlock, DocPageNav } from './components/DocCodeBlock'

/**
 * EVVM (Ethereum Virtual Virtual Machine) — deploy on Tempo testnet only for this project.
 * Docs: docs/EVVM_TEMPO.md · upstream https://www.evvm.info/
 */
export default function EvvmApp() {
  return (
    <main className="app app-cli-docs">
      <header className="hero">
        <h1>EVVM on Tempo testnet</h1>
        <p>
          <strong>EVVM</strong> deploys a virtual chain stack (Evvm, Staking, Estimator, NameService, Treasury,
          P2PSwap) onto a host L1. DanceTempo documents{' '}
          <strong>Tempo testnet (Moderato, chain ID 42431)</strong> only — see{' '}
          <a href="https://www.evvm.info/" target="_blank" rel="noreferrer">
            evvm.info
          </a>
          .
        </p>
        <DocPageNav
          links={[
            { href: '/', label: '← Hub' },
            { href: '/tempo-wallet', label: 'Tempo Wallet CLI' },
            { href: '/purl', label: 'Stripe purl' },
          ]}
        />
        <p className="doc-prose-muted" style={{ marginTop: '0.85rem' }}>
          Long-form: <code>docs/EVVM_TEMPO.md</code> · LLM bundle:{' '}
          <a href="https://www.evvm.info/llms-full.txt" target="_blank" rel="noreferrer">
            evvm.info/llms-full.txt
          </a>
        </p>
      </header>

      <section className="card doc-alert" style={{ borderLeftColor: '#f59e0b' }}>
        <h2 style={{ marginTop: 0 }}>Registry: skip for now</h2>
        <p>
          The optional step <strong>register in EVVM Registry</strong> (Ethereum Sepolia) assigns an official EVVM
          ID. We are <strong>waiting on the EVVM founding team</strong> to list / whitelist Tempo appropriately — so
          at the <code>register now?</code> prompt choose <strong>no</strong>. Deployment on{' '}
          <strong>Tempo testnet</strong> still works; you just won’t have a public registry ID yet.
        </p>
      </section>

      <section className="card doc-alert" style={{ borderLeftColor: '#6366f1' }}>
        <h2 style={{ marginTop: 0 }}>Chain allowlist</h2>
        <p>
          Upstream CLI may reject <strong>chain 42431</strong> if it is not in EVVM&apos;s supported testnet list yet.
          If deploy fails with “chain not supported”, follow EVVM&apos;s issue tracker; use a local chain (Anvil) for
          experiments per their docs.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Tempo testnet (host chain)</h2>
        <ul className="doc-prose-muted">
          <li>
            <strong>Chain ID:</strong> <code>42431</code>
          </li>
          <li>
            <strong>RPC:</strong>{' '}
            <code>https://rpc.moderato.tempo.xyz</code>
          </li>
          <li>
            <strong>Explorer:</strong>{' '}
            <a href="https://explore.testnet.tempo.xyz" target="_blank" rel="noreferrer">
              explore.testnet.tempo.xyz
            </a>
          </li>
          <li>
            Contract verification on Tempo: see{' '}
            <a href="https://contracts.tempo.xyz/docs" target="_blank" rel="noreferrer">
              contracts.tempo.xyz
            </a>{' '}
            (chain <code>42431</code>).
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Install in this repo</h2>
        <p className="doc-prose-muted">
          <strong>Library (npm):</strong> run <code>npm install @evvm/testnet-contracts</code> in your project when you
          need Solidity imports (not pinned in this app&apos;s <code>package.json</code> to avoid a heavy dependency
          tree). <strong>CLI:</strong> use the vendor installer (clones upstream + <code>./evvm install</code>).
        </p>
        <DocCodeBlock
          label="npm + vendor"
          code={`# From DanceTempo repo root — already in package.json after npm install
npm install

# Full Testnet-Contracts clone + ./evvm install → vendor/evvm-testnet-contracts/
npm run evvm:vendor`}
        />
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Configure &amp; deploy (Tempo testnet)</h2>
        <DocCodeBlock
          label=".env"
          code={`cd vendor/evvm-testnet-contracts
cp .env.example .env
# Set host chain RPC — Tempo testnet only for this guide:
RPC_URL="https://rpc.moderato.tempo.xyz"`}
        />
        <DocCodeBlock
          label="deploy"
          code={`cast wallet import defaultKey --interactive

./evvm deploy
# When asked to register on Ethereum Sepolia → answer n (see box above)`}
        />
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>References</h2>
        <ul className="doc-prose-muted">
          <li>
            <a href="https://www.evvm.info/docs/QuickStart" target="_blank" rel="noreferrer">
              EVVM QuickStart
            </a>
          </li>
          <li>
            <a href="https://github.com/EVVM-org/Testnet-Contracts" target="_blank" rel="noreferrer">
              EVVM-org/Testnet-Contracts
            </a>
          </li>
          <li>
            <a href="https://docs.tempo.xyz/quickstart/connection-details" target="_blank" rel="noreferrer">
              Tempo connection details
            </a>
          </li>
        </ul>
      </section>
    </main>
  )
}
