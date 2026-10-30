import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getBuffer } from './direct-http.js'

const VERSION = '26.9.30'

export function coreAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'Xray-macos-arm64-v8a.zip'
  if (platform === 'darwin' && arch === 'x64') return 'Xray-macos-64.zip'
  if (platform === 'linux' && arch === 'x64') return 'Xray-linux-64.zip'
  if (platform === 'linux' && arch === 'arm64') return 'Xray-linux-arm64-v8a.zip'
  if (platform === 'win32' && arch === 'x64') return 'Xray-windows-64.zip'
  if (platform === 'win32' && arch === 'arm64') return 'Xray-windows-arm64-v8a.zip'
  return null
}

export function parseDigest(text) {
  const match = String(text).match(/SHA2-256:\s*([0-9a-f]{64})/i)
  if (!match) throw new Error('release digest has no SHA2-256 value')
  return match[1].toLowerCase()
}

function extract(zip, destination) {
  const attempts =
    process.platform === 'win32'
      ? [['tar', ['-xf', zip, '-C', destination]]]
      : [['unzip', ['-o', zip, '-d', destination]], ['tar', ['-xf', zip, '-C', destination]]]
  for (const [command, args] of attempts) {
    if (spawnSync(command, args, { stdio: 'ignore' }).status === 0) return true
  }
  return false
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

/**
 * macOS/Linux have no bundled core package to rely on (Windows gets the
 * optional @twinsearth/dsh-2xray-core-win32-x64). When resolution fails, fetch
 * the official release for the current platform, verify the .dgst SHA2-256 and
 * place it in the managed data dir. TUN on macOS needs no wintun.dll: it uses
 * the system utun device and only requires root.
 */
export async function installCore({
  dataDir,
  version = VERSION,
  logger,
  timeoutMs = 120_000,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!dataDir) return { ok: false, error: 'data dir unavailable' }
  const asset = coreAsset(platform, arch)
  if (!asset) return { ok: false, error: `unsupported platform ${platform}/${arch}` }
  const base = `https://github.com/XTLS/Xray-core/releases/download/v${version}`
  const binaryName = platform === 'win32' ? 'xray.exe' : 'xray'
  const target = join(dataDir, 'bin', binaryName)
  if (existsSync(target)) return { ok: true, path: target, cached: true }

  try {
    logger?.info?.(`未找到 xray，自动下载 ${asset}（${version}）`)
    const zip = await getBuffer(`${base}/${asset}`, { timeoutMs })
    if (zip.status < 200 || zip.status >= 300) throw new Error(`HTTP ${zip.status}`)
    const digest = await getBuffer(`${base}/${asset}.dgst`, { timeoutMs })
    const expected = parseDigest(digest.body.toString('utf8'))
    const actual = createHash('sha256').update(zip.body).digest('hex')
    if (actual !== expected) throw new Error(`digest mismatch: expected ${expected}, got ${actual}`)

    const workspace = mkdtempSync(join(tmpdir(), 'dsh-xray-core-'))
    try {
      const archive = join(workspace, 'core.zip')
      writeFileSync(archive, zip.body)
      const out = join(workspace, 'out')
      mkdirSync(out, { recursive: true })
      if (!extract(archive, out)) throw new Error('could not extract core archive')
      const binary = findBinary(out, binaryName)
      if (!binary) throw new Error(`${binaryName} not found in archive`)
      mkdirSync(join(dataDir, 'bin'), { recursive: true })
      copyFileSync(binary, target)
      if (platform !== 'win32') chmodSync(target, 0o755)
      logger?.info?.(`xray 已下载到 ${target}`)
      return { ok: true, path: target, cached: false }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  } catch (error) {
    logger?.warn?.(`自动下载 xray 失败：${String(error.message ?? error)}`)
    return { ok: false, error: String(error.message ?? error) }
  }
}
