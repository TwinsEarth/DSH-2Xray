#!/usr/bin/env node
/**
 * Install an official Xray-core binary into the plugin data directory.
 *
 * The npm package does not embed five platform cores (that is ~150 MB). Instead
 * this one-shot installer downloads the official release asset for the current
 * platform, verifies the published SHA2-256 digest, extracts it, and places the
 * binary where the plugin already looks: <dataDir>/bin/xray(.exe).
 *
 * Usage:
 *   node tools/install-xray-core.mjs [version]
 *   XRAY_VERSION=26.9.30 node tools/install-xray-core.mjs
 *   DSH_XRAY_MIRROR=https://mirror.example/Xray-core/releases/download node tools/install-xray-core.mjs
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '26.9.30'

export function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'Xray-windows-64.zip'
  if (platform === 'win32' && arch === 'arm64') return 'Xray-windows-arm64-v8a.zip'
  if (platform === 'darwin' && arch === 'arm64') return 'Xray-macos-arm64-v8a.zip'
  if (platform === 'darwin' && arch === 'x64') return 'Xray-macos-64.zip'
  if (platform === 'linux' && arch === 'x64') return 'Xray-linux-64.zip'
  if (platform === 'linux' && arch === 'arm64') return 'Xray-linux-arm64-v8a.zip'
  throw new Error(`unsupported platform: ${platform}/${arch}`)
}

export function parseDigest(text) {
  const match = String(text).match(/SHA2-256:\s*([0-9a-f]{64})/i)
  if (!match) throw new Error('release digest has no SHA2-256 value')
  return match[1].toLowerCase()
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function dataBinDir() {
  const home = homedir()
  return join(home, '.dsh', 'xray-proxy', 'bin')
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function extract(zip, destination) {
  const attempts =
    process.platform === 'win32'
      ? [['tar', ['-xf', zip, '-C', destination]], ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destination}' -Force`]]]
      : [['unzip', ['-o', zip, '-d', destination]], ['tar', ['-xf', zip, '-C', destination]]]
  let lastError
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: 'ignore' })
    if (result.status === 0) return
    lastError = result.error ?? new Error(`${command} exited ${result.status}`)
  }
  throw lastError
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const nested = findBinary(full, name)
      if (nested) return nested
    }
  }
  return undefined
}

export async function main() {
  const version = process.argv[2] || process.env.XRAY_VERSION || DEFAULT_VERSION
  const asset = assetName()
  const mirror = (process.env.DSH_XRAY_MIRROR || 'https://github.com/XTLS/Xray-core/releases/download').replace(/\/$/, '')
  const url = `${mirror}/v${version.replace(/^v/, '')}/${asset}`
  const targetDir = dataBinDir()
  const targetName = process.platform === 'win32' ? 'xray.exe' : 'xray'
  const target = join(targetDir, targetName)

  if (existsSync(target)) {
    console.log(`already present: ${target}`)
    return target
  }

  console.log(`downloading ${url}`)
  const zip = await download(url)
  console.log(`verifying ${asset}.dgst`)
  const digestText = (await download(`${url}.dgst`)).toString('utf8')
  const expected = parseDigest(digestText)
  const actual = sha256(zip)
  if (expected !== actual) throw new Error(`digest mismatch: expected ${expected}, got ${actual}`)

  const workspace = mkdtempSync(join(tmpdir(), 'dsh-xray-core-'))
  try {
    const archive = join(workspace, asset)
    writeFileSync(archive, zip)
    const extracted = join(workspace, 'out')
    mkdirSync(extracted, { recursive: true })
    extract(archive, extracted)
    const binary = findBinary(extracted, targetName)
    if (!binary) throw new Error(`no ${targetName} inside ${asset}`)
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(binary, target)
    if (process.platform !== 'win32') chmodSync(target, 0o755)
    console.log(`installed ${target} (${Math.round(statSync(target).size / 1048576)} MB, v${version})`)
    return target
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`install failed: ${error.message ?? error}`)
    console.error('If GitHub is unreachable, set DSH_XRAY_MIRROR to a mirror and retry.')
    process.exitCode = 1
  })
}
