import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDiscoveryRoots, discoverXray } from './binary.js'

const FILES = ['geoip.dat', 'geosite.dat']

/**
 * `geoip:cn` / `geosite:cn` need data files next to the binary or in
 * XRAY_LOCATION_ASSET. A borrowed v2rayN binary keeps them one directory up,
 * so copy them into the managed data dir and point xray there.
 */
export function ensureXrayAssets({ binaryPath, dataDir, logger, discoveryRoots } = {}) {
  if (!dataDir) return { dir: undefined, copied: [], missing: FILES }
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    logger?.warn?.(`无法创建数据目录：${String(error)}`)
    return { dir: dataDir, copied: [], missing: FILES }
  }
  const candidates = [dataDir, dirname(binaryPath ?? ''), dirname(dirname(binaryPath ?? ''))]
  const missingBefore = FILES.some((name) => !existsSync(join(dataDir, name)))
  if (missingBefore) {
    // The resolved core may come from a package with no geodata. A local
    // v2rayN install usually has geoip.dat/geosite.dat next to its binaries.
    try {
      for (const discovered of discoverXray({ roots: discoveryRoots ?? defaultDiscoveryRoots(), timeBudgetMs: 1500, max: 4 })) {
        candidates.push(dirname(discovered), dirname(dirname(discovered)))
      }
    } catch {
      // discovery is best-effort; the managed dir may already have the files
    }
  }
  const copied = []
  const missing = []
  for (const name of FILES) {
    const target = join(dataDir, name)
    if (existsSync(target)) continue
    const source = candidates.find((dir) => dir && existsSync(join(dir, name)))
    if (!source) {
      missing.push(name)
      continue
    }
    try {
      copyFileSync(join(source, name), target)
      copied.push(name)
    } catch (error) {
      logger?.warn?.(`复制 ${name} 失败：${String(error)}`)
      missing.push(name)
    }
  }
  if (missing.length > 0) {
    logger?.warn?.(`缺少 xray 数据文件 ${missing.join(', ')}；cn-direct / geosite 规则可能启动失败，可从 v2rayN 的 bin/ 目录复制到 ${dataDir}`)
  }
  return { dir: dataDir, copied, missing }
}
