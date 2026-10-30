import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * TUN needs privileges and, on Windows, wintun.dll. Like v2rayN, the adapter
 * is created by the core; a Node plugin cannot elevate itself, so fail with a
 * readable reason instead of letting xray die on an opaque error.
 */
export function checkTunPrereqs({
  binaryPath,
  dataDir,
  platform = process.platform,
  isAdmin,
  fileExists = existsSync,
} = {}) {
  if (platform === 'win32') {
    const candidates = []
    if (binaryPath) candidates.push(join(dirname(binaryPath), 'wintun.dll'))
    if (dataDir) candidates.push(join(dataDir, 'wintun.dll'))
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
