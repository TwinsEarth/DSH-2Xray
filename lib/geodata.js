import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_BYTES = 100_000

export const GEODATA_FILES = [
  {
    file: 'geoip.dat',
    urls: [
      'https://github.com/XTLS/Xray-rules-dat/releases/latest/download/geoip-lite.dat',
      'https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat',
    ],
  },
  {
    file: 'geosite.dat',
    urls: [
      'https://github.com/XTLS/Xray-rules-dat/releases/latest/download/geosite.dat',
      'https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat',
    ],
  },
]

export function geodataStatus(dataDir) {
  if (!dataDir) return { files: [], stale: true, missing: GEODATA_FILES.map((entry) => entry.file) }
  const files = []
  const missing = []
  let oldest = Infinity
  for (const entry of GEODATA_FILES) {
    const path = join(dataDir, entry.file)
    try {
      const stat = statSync(path)
      files.push({ file: entry.file, size: stat.size, mtimeMs: stat.mtimeMs })
      oldest = Math.min(oldest, stat.mtimeMs)
    } catch {
      missing.push(entry.file)
    }
  }
  return {
    files,
    missing,
    stale: missing.length > 0 || Date.now() - oldest > DAY_MS,
    updatedAt: files.length > 0 ? Math.min(...files.map((entry) => entry.mtimeMs)) : null,
  }
}

async function download(url, timeoutMs) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < MIN_BYTES) throw new Error(`payload too small (${bytes.length} B)`)
  return bytes
}

/**
 * Xray accepts a top-level `geodata` block but does not execute its cron (live
 * test: no download within 85 s), so the host performs the update itself and
 * restarts the child afterwards. Writes are atomic per file.
 */
export async function updateGeodata({ dataDir, logger, timeoutMs = 30_000, force = false, files = GEODATA_FILES } = {}) {
  if (!dataDir) return { updated: [], failed: [], skipped: true }
  mkdirSync(dataDir, { recursive: true })
  const status = geodataStatus(dataDir)
  if (!force && !status.stale) {
    return { updated: [], failed: [], skipped: true, status }
  }
  const updated = []
  const failed = []
  for (const entry of files) {
    const target = join(dataDir, entry.file)
    let done = false
    for (const url of entry.urls) {
      try {
        const bytes = await download(url, timeoutMs)
        const temporary = `${target}.tmp-${process.pid}`
        writeFileSync(temporary, bytes)
        renameSync(temporary, target)
        updated.push({ file: entry.file, bytes: bytes.length, url })
        logger?.info?.(`规则数据已更新：${entry.file}（${(bytes.length / 1048576).toFixed(1)} MB）`)
        done = true
        break
      } catch (error) {
        logger?.warn?.(`下载 ${entry.file} 失败（${url}）：${String(error.message ?? error)}`)
      }
    }
    if (!done) {
      failed.push(entry.file)
      try {
        rmSync(`${target}.tmp-${process.pid}`, { force: true })
      } catch {
        // ignore
      }
    }
  }
  return { updated, failed, status: geodataStatus(dataDir) }
}
