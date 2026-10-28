import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
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
}) {
  const candidates = []
  const explicit = config.binary.path?.trim()
  if (explicit) candidates.push({ path: explicit, source: 'config' })
  const fromEnv = process.env.DSH_XRAY_BIN?.trim()
  if (fromEnv) candidates.push({ path: fromEnv, source: 'env' })
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

  throw new BinaryError(
    `找不到 xray-core 可执行文件。已尝试：${candidates.map((candidate) => candidate.path).join(', ') || '(无显式路径)'}，以及 PATH 中的 ${pathEntries.join(delimiter)}。` +
      '请把 xray 放进插件自己的 bin/、数据目录的 bin/，或设置 config.binary.path。',
    'binary-missing',
    candidates.map((candidate) => candidate.path),
  )
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
