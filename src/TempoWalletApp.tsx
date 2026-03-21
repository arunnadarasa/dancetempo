import './App.css'

/**
 * Showcase for the official Tempo Wallet CLI — https://github.com/tempoxyz/wallet
 * Complements in-browser MetaMask/mppx flows with passkey-based CLI + `tempo request`.
 */

const LOCAL_API = 'http://127.0.0.1:8787'

export default function TempoWalletApp() {
  return (
    <main className="app">
      <header className="hero">
        <h1>Tempo Wallet CLI</h1>
        <p>
          The official <strong>Tempo Wallet</strong> is a command-line wallet and HTTP client for{' '}
          <a href="https://tempo.xyz" target="_blank" rel="noreferrer">
            Tempo
          </a>{' '}
          with <strong>built-in Machine Payments Protocol (MPP)</strong> support — handle{' '}
          <code>402 Payment Required</code> in one command. Open source:{' '}
          <a href="https://github.com/tempoxyz/wallet" target="_blank" rel="noreferrer">
            github.com/tempoxyz/wallet
          </a>
          .
        </p>
        <p>
          <a href="/">← Hub</a>
          {' · '}
          <a href="/dance-extras">/dance-extras</a> (browser MPP)
          {' · '}
          <a href="https://github.com/arunnadarasa/dancetempo/blob/main/docs/PURL_DANCETEMPO.md">
            Stripe purl notes
          </a>
        </p>
      </header>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Why show this in DanceTempo?</h2>
        <p>
          DanceTech Protocol is the same <strong>pay-for-HTTP</strong> story everywhere: browser (<code>mppx</code>),
          CLI tools, and agents. <strong>Tempo Wallet</strong> uses <strong>passkey login</strong> (
          <code>tempo wallet login</code>) and scoped session keys — a first-class alternative to MetaMask for
          terminal and automation workflows.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Install</h2>
        <p>From the upstream README — installs the <code>tempo</code> launcher and wallet extensions:</p>
        <pre
          style={{
            background: '#18181b',
            color: '#fafafa',
            padding: '1rem',
            borderRadius: 8,
            overflow: 'auto',
            fontSize: '0.85rem',
          }}
        >
          <code>curl -fsSL https://tempo.xyz/install | bash</code>
        </pre>
        <p className="intent">
          Optional global skill (from their repo):{' '}
          <code>npx skills@latest add tempoxyz/wallet --global</code>
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Log in &amp; fund (testnet)</h2>
        <ol>
          <li>
            <code>tempo wallet login</code> — opens browser for passkey auth at{' '}
            <code>wallet.tempo.xyz</code>.
          </li>
          <li>
            <code>tempo wallet whoami</code> — verify session.
          </li>
          <li>
            <code>tempo wallet fund</code> — faucet / top-up on testnet as documented upstream.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>One-shot <code>tempo request</code> (catalog MPP)</h2>
        <p>Example from Tempo Wallet docs — paid API without API keys:</p>
        <pre
          style={{
            background: '#18181b',
            color: '#fafafa',
            padding: '1rem',
            borderRadius: 8,
            overflow: 'auto',
            fontSize: '0.8rem',
            lineHeight: 1.45,
          }}
        >
          <code>
            {`# Preview cost
tempo request --dry-run \\
  "https://aviationstack.mpp.tempo.xyz/v1/flights?flight_iata=AA100"

# Execute
tempo request \\
  "https://aviationstack.mpp.tempo.xyz/v1/flights?flight_iata=AA100"`}
          </code>
        </pre>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>DanceTempo API (local)</h2>
        <p>
          With <code>npm run server</code> running (default <strong>port 8787</strong>), you can point{' '}
          <strong>tempo request</strong> at the same live MPP routes the browser uses on{' '}
          <code>/dance-extras</code>:
        </p>
        <pre
          style={{
            background: '#18181b',
            color: '#fafafa',
            padding: '1rem',
            borderRadius: 8,
            overflow: 'auto',
            fontSize: '0.75rem',
            lineHeight: 1.45,
          }}
        >
          <code>
            {`BODY='{"network":"testnet","battleId":"battle_demo","roundId":"round_1","judgeId":"judge_1","dancerId":"dancer_1","score":8.7}'

tempo request --dry-run -X POST --json "$BODY" \\
  "${LOCAL_API}/api/dance-extras/live/judge-score/testnet"

# When ready to pay on-chain (testnet funds required):
tempo request -X POST --json "$BODY" \\
  "${LOCAL_API}/api/dance-extras/live/judge-score/testnet"`}
          </code>
        </pre>
        <p className="intent">
          Requires <code>MPP_SECRET_KEY</code> and <code>MPP_RECIPIENT</code> on the server — same as browser live
          mode. Use <strong>Tempo testnet</strong> first.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Session-based requests</h2>
        <p>
          Tempo Wallet supports <strong>session / channel</strong> payments for streaming and repeat calls (e.g.{' '}
          <code>openrouter.mpp.tempo.xyz</code>). See the{' '}
          <a href="https://github.com/tempoxyz/wallet#session-payment-channel" target="_blank" rel="noreferrer">
            Session Payment section
          </a>{' '}
          in the upstream README.
        </p>
      </section>

      <section className="card api">
        <h3>References</h3>
        <div className="api-list">
          <a href="https://github.com/tempoxyz/wallet">tempoxyz/wallet (GitHub)</a>
          <a href="https://tempo.xyz">tempo.xyz</a>
          <a href="https://mpp.dev">mpp.dev</a>
          <a href="https://github.com/arunnadarasa/dancetempo">DanceTempo (this repo)</a>
        </div>
      </section>
    </main>
  )
}
