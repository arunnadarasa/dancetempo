#!/usr/bin/env node
/**
 * Clone EVVM-org/Testnet-Contracts into vendor/evvm-testnet-contracts and run `./evvm install`
 * (Bun + Foundry deps). Requires: git, bun, foundry (forge/cast).
 *
 * Usage: node scripts/install-evvm.mjs
 */
import { execSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const vendorDir = join(root, 'vendor')
const target = join(vendorDir, 'evvm-testnet-contracts')
const repo = 'https://github.com/EVVM-org/Testnet-Contracts.git'

mkdirSync(vendorDir, { recursive: true })

if (!existsSync(join(target, 'evvm'))) {
  console.log(`Cloning EVVM CLI repo into ${target} …`)
  execSync(`git clone --recursive "${repo}" "${target}"`, { stdio: 'inherit', cwd: vendorDir })
} else {
  console.log(`Already present: ${target} (remove folder to re-clone)`)
}

const evvmBin = join(target, 'evvm')
if (!existsSync(evvmBin)) {
  console.error('Missing evvm launcher after clone:', evvmBin)
  process.exit(1)
}

try {
  chmodSync(evvmBin, 0o755)
} catch {
  /* ignore */
}

console.log('Running ./evvm install (Bun + forge deps) …')
const r = spawnSync(evvmBin, ['install'], { cwd: target, stdio: 'inherit' })
if (r.status !== 0) {
  process.exit(r.status ?? 1)
}
console.log('Done. cd vendor/evvm-testnet-contracts && cp .env.example .env — set RPC_URL for Tempo testnet (see docs/EVVM_TEMPO.md).')
