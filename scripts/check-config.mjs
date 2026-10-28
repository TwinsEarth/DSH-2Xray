#!/usr/bin/env node
/**
 * Build a config for a JSON config file and validate it with a real xray binary:
 *
 *   node scripts/check-config.mjs --config my.json --xray C:\path\to\xray.exe
 *
 * `--security none --network tcp --flow ""` in the JSON downgrades the stream
 * for old binaries that predate REALITY. The generated file is written to the
 * OS temp directory and printed so the exact bytes can be inspected.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'

const args = process.argv.slice(2)
const getArg = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const configPath = getArg('--config')
const xray = getArg('--xray') ?? process.env.XRAY_BIN
if (!configPath || !xray) {
  console.error('usage: node scripts/check-config.mjs --config <json> --xray <path>')
  process.exit(2)
}

const { readFileSync } = await import('node:fs')
const raw = JSON.parse(readFileSync(configPath, 'utf8'))
const result = normalizeConfig(raw)
if (result.errors.length > 0) {
  for (const error of result.errors) console.error(`${error.field}: ${error.message}`)
  process.exit(3)
}

const built = buildXrayConfig(result.config)
if (args.includes('--legacy')) {
  // Pre-1.8 binaries call the raw transport "tcp" and reject "raw".
  for (const outbound of built.outbounds) {
    if (outbound.streamSettings?.network === 'raw') outbound.streamSettings.network = 'tcp'
  }
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-check-'))
const file = join(dir, 'xray-config.json')
writeFileSync(file, `${JSON.stringify(built, null, 2)}\n`, { mode: 0o600 })
console.log(`config: ${file}`)

const outcome = spawnSync(xray, ['run', '-test', '-c', file], { stdio: 'inherit' })
if (outcome.status !== 0) {
  console.error(`xray run -test exited ${outcome.status ?? outcome.error?.code ?? 'unknown'}`)
  process.exit(1)
}
console.log('Configuration OK.')
