import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The harness home. `DSH_HOME` is the documented override; the desktop app
 * keeps everything under `~/.dsh`.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Resolve the plugin data directory and create it with restrictive
 * permissions. The directory holds the generated xray config, which carries
 * the VLESS uuid and the REALITY key.
 *
 * @param {object} config - normalized config.
 * @returns {string} absolute data directory.
 */
export function resolveDataDir(config) {
  const dir = config.binary.dataDir?.trim()
    ? config.binary.dataDir.trim()
    : join(resolveDshHome(), 'xray-proxy')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows ignores POSIX modes; access is governed by the user's profile.
  }
  return dir
}

export function atomicWriteFile(file, content, mode = 0o600) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, content, { mode })
    try {
      chmodSync(temp, mode)
    } catch {
      // see resolveDataDir
    }
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // best effort
    }
    throw error
  }
}

export function atomicWriteJson(file, value, mode = 0o600) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}
