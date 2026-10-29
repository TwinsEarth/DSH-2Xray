import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, so a bundle that ships its own `bin/xray(.exe)` is found first. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

function raceTimeout(promise, ms, timeoutValue) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutValue), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

export class BinaryError extends Error {
  constructor(message, code = 'binary-missing', candidates = []) {
    super(message)
    this.name = 'BinaryError'
    this.code = code
    this.candidates = candidates
  }
}

function executableName() {
  return process.platform === 'win32' ? 'xray.exe' : 'xray'
}

/**
 * Platform cores are published as separate optional packages so the main
 * package stays small. npm installs only the matching os/cpu one.
 */
export function optionalCorePaths({ platform = process.platform, arch = process.arch, resolvePackage } = {}) {
  const name = `@twinsearth/dsh-2xray-core-${platform}-${arch}`
  const resolver = resolvePackage ?? ((specifier) => createRequire(import.meta.url).resolve(specifier))
  try {
    const manifest = resolver(`${name}/package.json`)
    const base = dirname(manifest)
    const executable = platform === 'win32' ? 'xray.exe' : 'xray'
    return [...new Set([join(base, 'bin', executable), join(base, 'bin', 'xray')])]
  } catch {
    return []
  }
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    // Windows has no execute bit; X_OK approximates "readable and present".
    return existsSync(file) && process.platform === 'win32'
  }
}

/**
 * Resolve the xray executable without downloading anything (v1 never fetches).
 *
 * Order: explicit `binary.path`, `DSH_XRAY_BIN`, the plugin's own `bin/` (a
 * bundle may ship the binary), the managed data directory's `bin/`, then PATH
 * (through `ctx.subprocess.resolveExecutable` when available).
 *
 * @returns {Promise<{ path: string, source: 'config'|'env'|'bundled'|'managed'|'path' }>}
 */
export async function resolveBinary({
  config,
  dataDir,
  launcher,
  exists = isExecutable,
  packageRoot = PACKAGE_ROOT,
  discoveryRoots,
  discoveryOptions = {},
  resolvePackage,
}) {
  const candidates = []
  const explicit = config.binary.path?.trim()
  if (explicit) candidates.push({ path: explicit, source: 'config' })
  const fromEnv = process.env.DSH_XRAY_BIN?.trim()
  if (fromEnv) candidates.push({ path: fromEnv, source: 'env' })
  for (const path of optionalCorePaths({ resolvePackage })) {
    candidates.push({ path, source: 'core-package' })
  }
  candidates.push({ path: join(packageRoot, 'bin', executableName()), source: 'bundled' })
  candidates.push({ path: join(packageRoot, 'bin', 'xray'), source: 'bundled' })
  candidates.push({ path: join(dataDir, 'bin', executableName()), source: 'managed' })
  candidates.push({ path: join(dataDir, 'bin', 'xray'), source: 'managed' })

  for (const candidate of candidates) {
    if (exists(candidate.path)) return { path: candidate.path, source: candidate.source }
  }

  // PATH lookup, honouring PATHEXT on Windows.
  if (launcher?.resolveExecutable) {
    try {
      const resolved = await launcher.resolveExecutable('xray')
      if (typeof resolved === 'string' && resolved) {
        return { path: resolved, source: 'path' }
      }
    } catch {
      // fall through to the manual scan below
    }
  }

  const names = process.platform === 'win32' ? ['xray.exe', 'xray'] : ['xray']
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name)
      if (exists(candidate)) return { path: candidate, source: 'path' }
    }
  }

  // v2rayN / v2rayN-core ship xray under their own directory (7.x uses
  // bin/xray/xray.exe). Borrowing it avoids asking the user to copy a binary.
  const discovered = discoverXray({ roots: discoveryRoots, ...discoveryOptions })
  if (discovered.length > 0) {
    return { path: discovered[0], source: 'discovered' }
  }

  throw new BinaryError(
    `找不到 xray-core 可执行文件。已尝试：${candidates.map((candidate) => candidate.path).join(', ') || '(无显式路径)'}，以及 PATH 中的 ${pathEntries.join(delimiter)}。` +
      '请把 xray 放进插件自己的 bin/、数据目录的 bin/，或设置 config.binary.path。',
    'binary-missing',
    [...candidates.map((candidate) => candidate.path), ...discovered],
  )
}

/** Common install roots for a borrowed xray binary (Windows-first). */
export function defaultDiscoveryRoots() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  const roots = [
    process.env.V2RAYN_HOME,
    process.env.V2RAYN_PATH,
    local,
    home ? join(home, 'Desktop') : '',
    home ? join(home, 'Downloads') : '',
    // macOS: v2rayN keeps its core under Application Support, not ~/bin.
    home ? join(home, 'Library', 'Application Support') : '',
    home ? join(home, '.local', 'bin') : '',
    '/Applications',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\',
    'E:\\',
    'C:\\',
  ]
  return [...new Set(roots.filter((root) => typeof root === 'string' && root.length > 0))]
}

/**
 * Bounded search for a v2rayN-style xray layout. Directory names must look
 * like v2rayN, so the walk does not crawl unrelated trees; the time budget
 * keeps a failed start from stalling activation.
 */
export function discoverXray({ roots = defaultDiscoveryRoots(), timeBudgetMs = 3000, max = 5 } = {}) {
  const found = []
  const deadline = Date.now() + timeBudgetMs
  const skipped = /^(windows|programdata|recovery|\$recycle\.bin|system volume information|node_modules|\.git|appdata|temp)$/i
  const layouts = [
    ['bin', 'xray', 'xray.exe'],
    ['bin', 'xray', 'xray'],
    ['bin', 'xray.exe'],
    ['bin', 'xray'],
    ['xray.exe'],
    ['xray'],
  ]
  const check = (dir) => {
    for (const parts of layouts) {
      const candidate = join(dir, ...parts)
      if (existsSync(candidate)) {
        if (!found.includes(candidate)) found.push(candidate)
        return
      }
    }
  }
  const visit = (dir, depth) => {
    if (found.length >= max || Date.now() > deadline) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= max || Date.now() > deadline) return
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (skipped.test(name)) continue
      const full = join(dir, name)
      if (/v2ray/i.test(name)) check(full)
      if (depth < 3) visit(full, depth + 1)
    }
  }
  for (const root of roots) {
    if (found.length >= max || Date.now() > deadline) break
    if (existsSync(root)) visit(root, 0)
  }
  return found
}

/**
 * Run `xray version` and parse the version line. A failed probe (missing
 * dynamic library, wrong architecture, antivirus block) is a startup failure,
 * so it is reported rather than ignored; only an unparsable version is a
 * warning.
 */
export async function probeVersion({ launcher, binaryPath, timeoutMs = 5000 }) {
  const handle = launcher.spawn({
    argv: [binaryPath, 'version'],
    cwd: process.cwd(),
    graceMs: Math.max(500, timeoutMs),
    env: {},
  })
  const outcome = await raceTimeout(handle.done, timeoutMs, { timedOut: true })
  if (outcome?.timedOut) {
    await handle.terminate()
    return { ok: false, version: undefined, detail: 'xray version 探测超时' }
  }
  if (outcome?.error) {
    return { ok: false, version: undefined, detail: String(outcome.error) }
  }
  const text = `${handle.stdoutTail?.() ?? ''}\n${handle.stderrTail?.() ?? ''}`
  if (outcome.exitCode !== 0) {
    return { ok: false, version: undefined, detail: tail(text) || `xray version 退出码 ${outcome.exitCode}` }
  }
  const version = /Xray\s+([0-9][^\s(]*)/i.exec(text)?.[1]
  return { ok: true, version, detail: version ? `xray ${version}` : tail(text) }
}

export function tail(text, limit = 1200) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed
}
