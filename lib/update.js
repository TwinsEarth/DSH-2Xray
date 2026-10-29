import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PACKAGE_NAME = '@twinsearth/dsh-2xray'
const REGISTRY = 'https://registry.npmjs.org'

function readOwnVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

/** Numeric semver comparison; a prerelease sorts before the release. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre] = String(value).replace(/^v/, '').split('-', 2)
    const parts = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { parts, pre: pre ?? '' }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre > b.pre ? 1 : -1
}

export function checkForUpdate({ current = readOwnVersion(), registry = REGISTRY, packageName = PACKAGE_NAME } = {}) {
  return fetch(`${registry}/${encodeURIComponent(packageName)}/latest`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
      const meta = await response.json()
      const latest = String(meta.version ?? '')
      if (!latest) throw new Error('registry response has no version')
      return {
        current,
        latest,
        available: compareVersions(latest, current) > 0,
        checkedAt: Date.now(),
        tarball: meta.dist?.tarball,
        integrity: meta.dist?.integrity,
        shasum: meta.dist?.shasum,
      }
    })
    .catch((error) => ({ current, latest: null, available: false, error: String(error.message ?? error), checkedAt: Date.now() }))
}

function verify(bytes, { integrity, shasum }) {
  if (integrity?.startsWith('sha512-')) {
    const actual = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
    return actual === integrity
  }
  if (shasum) {
    return createHash('sha1').update(bytes).digest('hex') === shasum
  }
  return false
}

function extractTarball(file, destination) {
  const attempts = [
    ['tar', ['-xzf', file, '-C', destination]],
    ['tar', ['-xf', file, '-C', destination]],
  ]
  for (const [command, argv] of attempts) {
    if (spawnSync(command, argv, { stdio: 'ignore' }).status === 0) return true
  }
  return false
}

function copyTree(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

/**
 * Install a newer tarball over the running package directory. The swap is
 * rename-based with a rollback copy, and the caller must restart DSH: the
 * already-loaded modules keep running the old code.
 */
export async function installUpdate(info, { packageRoot = PACKAGE_ROOT, logger } = {}) {
  if (!info?.available || !info.tarball) return { ok: false, error: 'no update available' }
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-2xray-update-'))
  const target = packageRoot
  const backup = `${target}.bak-${Date.now()}`
  try {
    const response = await fetch(info.tarball, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
    if (!response.ok) throw new Error(`tarball HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!verify(bytes, info)) throw new Error('tarball integrity check failed')
    const archive = join(workspace, 'package.tgz')
    writeFileSync(archive, bytes)
    const extracted = join(workspace, 'out')
    mkdirSync(extracted, { recursive: true })
    if (!extractTarball(archive, extracted)) throw new Error('could not extract tarball')
    const packageDir = join(extracted, 'package')
    if (!existsSync(join(packageDir, 'package.json'))) throw new Error('tarball has no package/ directory')
    renameSync(target, backup)
    try {
      copyTree(packageDir, target)
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      renameSync(backup, target)
      throw error
    }
    rmSync(backup, { recursive: true, force: true })
    logger?.info?.(`已更新到 ${info.latest}，重启 DSH 后生效`)
    return { ok: true, version: info.latest, restartRequired: true }
  } catch (error) {
    logger?.error?.(`更新失败：${String(error.message ?? error)}`)
    return { ok: false, error: String(error.message ?? error) }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

export function ownVersion() {
  return readOwnVersion()
}

export function packageSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
