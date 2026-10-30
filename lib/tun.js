import { copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Copy the bundled wintun.dll next to the resolved xray executable. Windows
 * loads it from the executable's directory; a Node plugin cannot register a
 * DLL search path, so the file has to be there before the first TUN start.
 */
export function ensureWintun({
  binaryPath,
  packageRoot,
  logger,
  platform = process.platform,
  fileExists = existsSync,
  copy = copyFileSync,
} = {}) {
  if (platform !== 'win32') return { ok: true, copied: false, path: null }
  if (!binaryPath) return { ok: false, copied: false, error: 'binary path missing' }
  const target = join(dirname(binaryPath), 'wintun.dll')
  if (fileExists(target)) return { ok: true, copied: false, path: target }
  const source = packageRoot ? join(packageRoot, 'bin', 'wintun.dll') : undefined
  if (!source || !fileExists(source)) {
    return { ok: false, copied: false, error: 'bundled wintun.dll is missing' }
  }
  try {
    copy(source, target)
    logger?.info?.(`已复制 wintun.dll 到 xray 目录：${target}`)
    return { ok: true, copied: true, path: target }
  } catch (error) {
    return { ok: false, copied: false, error: String(error.message ?? error) }
  }
}

/**
 * TUN needs privileges and, on Windows, wintun.dll. Like v2rayN, the adapter
 * is created by the core; a Node plugin cannot elevate itself, so fail with a
 * readable reason instead of letting xray die on an opaque error.
 */
export function checkTunPrereqs({
  binaryPath,
  dataDir,
  packageRoot,
  platform = process.platform,
  isAdmin,
  fileExists = existsSync,
} = {}) {
  if (platform === 'win32') {
    const candidates = []
    if (binaryPath) candidates.push(join(dirname(binaryPath), 'wintun.dll'))
    if (dataDir) candidates.push(join(dataDir, 'wintun.dll'))
    if (packageRoot) candidates.push(join(packageRoot, 'bin', 'wintun.dll'))
    if (process.env.SystemRoot) candidates.push(join(process.env.SystemRoot, 'System32', 'wintun.dll'))
    if (!candidates.some((candidate) => fileExists(candidate))) {
      return {
        ok: false,
        code: 'tun-wintun-missing',
        detail: `TUN 模式需要 wintun.dll；已查找：${candidates.join(', ')}。可从 v2rayN 的目录复制 wintun.dll 到 xray 可执行文件旁，或关闭 TUN 模式。`,
      }
    }
  }

  const admin = typeof isAdmin === 'boolean' ? isAdmin : defaultIsAdmin(platform)
  if (!admin) {
    return {
      ok: false,
      code: 'tun-admin-required',
      detail:
        platform === 'win32'
          ? 'TUN 模式需要管理员权限创建虚拟网卡。请以管理员身份启动 DSH，或关闭 TUN 模式改用 --proxy-server/系统代理。'
          : 'TUN 模式需要 root 权限创建虚拟网卡。请用 sudo 启动 DSH，或关闭 TUN 模式。',
    }
  }

  return { ok: true, code: null, detail: null }
}

function defaultIsAdmin(platform) {
  if (platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0
  }
  try {
    return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}
