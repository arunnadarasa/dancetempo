#!/usr/bin/env node
/**
 * Concatenate canonical docs into public/llm-full.txt for LLM / agent context.
 * Run: node scripts/build-llm-full.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const FILES = [
  ['README.md', 'README.md'],
  ['CLAWHUB.md', 'CLAWHUB.md'],
  ['DANCETECH_USE_CASES.md', 'DANCETECH_USE_CASES.md'],
  ['DANCE_TECH_PROTOCOL_AZ.md', 'DANCE_TECH_PROTOCOL_AZ.md'],
  ['docs/PURL_DANCETEMPO.md', 'docs/PURL_DANCETEMPO.md'],
  ['docs/TEMPO_WALLET_TEST.md', 'docs/TEMPO_WALLET_TEST.md'],
  ['docs/EVVM_TEMPO.md', 'docs/EVVM_TEMPO.md'],
]

const header = `# DanceTempo / DanceTech Protocol — LLM context bundle

**Purpose:** Single file to paste into an LLM system prompt, upload to a coding agent, or feed RAG — **full orientation** to this repository.

**Generated:** ${new Date().toISOString()} (re-run \`npm run build:llm\` after doc edits)

**Download (running app):** \`/llm-full.txt\` from the dev server or production site.

**In repo:** \`public/llm-full.txt\` (served as static file; also clone and open locally).

---

## How to use

1. **ChatGPT / Claude / etc.:** Attach this file or paste relevant sections into project instructions.
2. **Cursor / IDE agents:** @-mention \`public/llm-full.txt\` or paste the sections you need.
3. **OpenClaw / automation:** Prefer \`CLAWHUB.md\` for tribal debugging + this bundle for full product/API context.

## What’s inside (concatenated)

The following sections are **verbatim** exports from the repo (order matters for context).

---

`

function main() {
  const parts = [header]
  for (const [relPath, label] of FILES) {
    const abs = join(root, relPath)
    let body
    try {
      body = readFileSync(abs, 'utf8')
    } catch {
      console.warn(`skip missing: ${relPath}`)
      continue
    }
    parts.push(`\n\n## >>> BEGIN FILE: ${label}\n\n`)
    parts.push(body)
    parts.push(`\n\n## <<< END FILE: ${label}\n`)
  }

  const outDir = join(root, 'public')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'llm-full.txt')
  writeFileSync(outPath, parts.join(''), 'utf8')
  const lines = parts.join('').split('\n').length
  console.log(`Wrote ${outPath} (${lines} lines)`)
}

main()
