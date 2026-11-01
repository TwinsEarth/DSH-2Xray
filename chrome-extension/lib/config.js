/**
 * Configuration defaults + normalization for the 2Xray Chrome extension.
 *
 * Mirrors DSH-2Xray's defaults (routing lists, VLESS validation, inbound port
 * fallback) but keeps only what a browser extension can act on: Chrome proxy
 * settings, PAC routing, a single active VLESS profile and probe endpoints.
 *
 * Normalization never throws. It returns `{ config, errors, warnings }` so the
 * popup/options can show field-level messages instead of failing to boot.
 */

import { parseShareLink } from './share-link.js'

export const ROUTING_MODES = ['global', 'whitelist', 'cn-direct']
export const PROXY_PROTOCOLS = ['http', 'socks']

/** Same whitelist default as the DSH plugin. */
export const DEFAULT_WHITELIST = [
  'github.com',
  'google.com',
  'youtube.com',
  'x.com',
  'facebook.com',
  'api.github.com',
  'raw.githubusercontent.com',
]

/**
 * Same blacklist default as the DSH plugin. The URL form is accepted on
 * purpose: users paste `https://registry.npmjs.org/` from settings, and
 * normalization reduces it to the host so both spellings dedupe.
 */
export const DEFAULT_BLACKLIST = [
  'deepseek.com',
  'chat.deepseek.com',
  'api.deepseek.com',
  'download.deepseek.com',
  'api-docs.deepseek.com',
  'platform.deepseek.com',
  'registry.npmjs.org',
  'https://registry.npmjs.org/',
]

export const DEFAULT_CONFIG = {
  /** Master switch: install/uninstall the Chrome proxy configuration. */
  enabled: false,
  proxy: {
    protocol: 'http',
    host: '127.0.0.1',
    port: 20808,
  },
  routing: {
    mode: 'global',
    whitelist: [...DEFAULT_WHITELIST],
    blacklist: [...DEFAULT_BLACKLIST],
    /** Always direct; bare labels are allowed (`lan` matches `printer.lan`). */
    bypassDomains: ['localhost', 'local', 'lan', 'internal', 'corp', 'home.arpa', 'home'],
  },
  probe: {
    /** Whitelisted by default so latency measures the tunnel, not direct. */
    latencyUrl: 'https://www.google.com/generate_204',
    ipUrl: 'https://ipinfo.io/json',
    timeoutMs: 8000,
    intervalMinutes: 2,
  },
  profile: {
    shareLink: '',
    /** Normalized VLESS node, derived from `shareLink`; never edited directly. */
    node: null,
    name: '',
  },
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/
const SHORT_ID_RE = /^(?:[0-9a-fA-F]{2})*$/
const FLOWS = new Set(['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'])
const NETWORKS = new Set(['raw', 'tcp'])
const SECURITIES = new Set(['reality', 'tls', 'none'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function merge(base, patch) {
  if (!isObject(patch)) return base
  const out = isObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value)
    else out[key] = clone(value)
  }
  return out
}

function asString(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback
}

function asInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true
    if (/^(0|false|no|off)$/i.test(value.trim())) return false
  }
  return fallback
}

function asStringList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

/** Unicode host -> punycode ASCII host without throwing. */
function toAsciiHost(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (!value) return ''
  if (value.includes(':')) return '' // IPv6 literals are not domain rules
  try {
    return new URL(`http://${value}`).hostname.replace(/\.$/, '')
  } catch {
    return ''
  }
}

/**
 * Normalize routing entries. Accepts bare domains, `*.domain` and full URLs
 * (`https://registry.npmjs.org/`); strips scheme, port, path, wildcard prefix
 * and trailing dot, then reduces to a lowercase ASCII host.
 */
export function normalizeDomainList(entries, { allowBare = false } = {}) {
  const result = []
  for (const entry of asStringList(entries)) {
    let text = String(entry).trim().toLowerCase()
    if (!text || text.startsWith('#') || text.startsWith('//')) continue
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    text = text.split(/[/?#]/)[0]
    text = text.replace(/:\d+$/, '')
    text = text.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '')
    if (!text || text.includes('*') || /\s/.test(text)) continue
    const host = toAsciiHost(text)
    if (!host) continue
    if (host.includes(':')) continue
    const valid = allowBare
      ? /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)
      : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    if (!valid) continue
    if (!result.includes(host)) result.push(host)
  }
  return result
}

/** Keep a node in the shape the config generator and UI expect. */
function normalizeNode(raw) {
  const network = raw.network === 'tcp' ? 'raw' : String(raw.network ?? 'raw').toLowerCase()
  return {
    id: asString(raw.id, '') || 'VLESS 节点',
    tag: 'proxy',
    address: asString(raw.address, ''),
    port: asInt(raw.port, 443),
    uuid: asString(raw.uuid, ''),
    flow: asString(raw.flow, network === 'raw' ? 'xtls-rprx-vision' : ''),
    serverName: asString(raw.serverName, ''),
    password: asString(raw.password, ''),
    publicKey: asString(raw.publicKey, ''),
    shortId: asString(raw.shortId, ''),
    fingerprint: asString(raw.fingerprint, 'chrome'),
    spiderX: asString(raw.spiderX, '/'),
    network,
    security: asString(raw.security, 'reality').toLowerCase(),
  }
}

function validateNode(node, errors, warnings) {
  if (!node.address) errors.push({ field: 'profile.address', message: '服务端地址不能为空' })
  else if (!/^[^\s/]+$/.test(node.address)) errors.push({ field: 'profile.address', message: '服务端地址不能包含空格或斜杠' })
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    errors.push({ field: 'profile.port', message: '服务端端口必须是 1..65535 的整数' })
  }
  if (!node.uuid) errors.push({ field: 'profile.uuid', message: 'VLESS uuid 不能为空' })
  else if (!UUID_RE.test(node.uuid) && node.uuid.length > 30) {
    errors.push({ field: 'profile.uuid', message: 'uuid 既不是标准 UUID，也超过 30 字节' })
  } else if (!UUID_RE.test(node.uuid)) {
    warnings.push('uuid 不是标准 UUID，将按 VLESS 字符串 id 处理')
  }

  if (!NETWORKS.has(node.network)) {
    errors.push({
      field: 'profile.network',
      message: `扩展只生成 raw/tcp VLESS 出站，收到 type=${node.network}；请在 Xray 内核侧使用 ws/grpc 等传输`,
    })
  }
  if (!SECURITIES.has(node.security)) {
    errors.push({ field: 'profile.security', message: `security 只支持 reality/tls/none，收到 ${node.security}` })
  }
  if (!FLOWS.has(node.flow)) {
    errors.push({ field: 'profile.flow', message: `flow 只支持 ""/xtls-rprx-vision/xtls-rprx-vision-udp443，收到 ${node.flow}` })
  }
  if (node.flow !== '' && (node.network !== 'raw' || !['reality', 'tls'].includes(node.security))) {
    errors.push({ field: 'profile.flow', message: 'flow 非空时 network 必须是 raw/tcp 且 security 必须是 reality/tls' })
  }

  if (node.security === 'reality') {
    if (!node.serverName) errors.push({ field: 'profile.serverName', message: 'REALITY 必须提供 sni' })
    if (!node.password && !node.publicKey) {
      errors.push({ field: 'profile.password', message: 'REALITY 必须提供 pbk（X25519 公钥）' })
    }
    for (const candidate of [node.password, node.publicKey]) {
      if (candidate && !BASE64URL_32_RE.test(candidate)) {
        errors.push({ field: 'profile.password', message: 'REALITY 公钥必须是 43 字符 base64url' })
        break
      }
    }
    if (node.shortId && (!SHORT_ID_RE.test(node.shortId) || node.shortId.length > 16)) {
      errors.push({ field: 'profile.shortId', message: 'shortId 必须是偶数长度 hex，且不超过 16 个字符' })
    }
    if (!node.fingerprint) errors.push({ field: 'profile.fingerprint', message: 'REALITY 必须提供 uTLS 指纹' })
    if (!node.spiderX.startsWith('/')) errors.push({ field: 'profile.spiderX', message: 'spx 必须以 / 开头' })
  } else if (node.security === 'tls') {
    if (!node.serverName) errors.push({ field: 'profile.serverName', message: 'TLS 必须提供 sni' })
  }
}

function normalizeProbeUrl(value, fallback, field, errors) {
  const text = asString(value, fallback)
  try {
    const url = new URL(text)
    if (!/^https?:$/.test(url.protocol)) throw new Error('scheme')
    return url.toString()
  } catch {
    errors.push({ field, message: '必须是合法的 http(s) URL' })
    return fallback
  }
}

/**
 * @param {unknown} raw - plain object from chrome.storage.local.
 * @returns {{config: object, errors: {field: string, message: string}[], warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const errors = []
  const warnings = []
  const merged = merge(clone(DEFAULT_CONFIG), isObject(raw) ? raw : {})

  merged.enabled = asBool(merged.enabled, false)

  const proxy = merged.proxy
  proxy.protocol = asString(proxy.protocol, 'http').toLowerCase()
  proxy.host = asString(proxy.host, '127.0.0.1')
  proxy.port = asInt(proxy.port, DEFAULT_CONFIG.proxy.port)
  if (!PROXY_PROTOCOLS.includes(proxy.protocol)) {
    errors.push({ field: 'proxy.protocol', message: '协议只支持 http 或 socks' })
  }
  if (!proxy.host || /\s/.test(proxy.host)) errors.push({ field: 'proxy.host', message: '本地入站地址不能为空' })
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    errors.push({ field: 'proxy.port', message: '本地入站端口必须是 1..65535 的整数' })
  } else if (proxy.port < 1024) {
    warnings.push(`端口 ${proxy.port} 是特权端口；Xray 入站通常使用 20808`)
  }

  const routing = merged.routing
  routing.mode = asString(routing.mode, 'global').toLowerCase()
  routing.whitelist = normalizeDomainList(routing.whitelist)
  routing.blacklist = normalizeDomainList(routing.blacklist)
  routing.bypassDomains = normalizeDomainList(routing.bypassDomains, { allowBare: true })
  if (!ROUTING_MODES.includes(routing.mode)) {
    errors.push({ field: 'routing.mode', message: '路由模式只支持 global、whitelist、cn-direct' })
  }
  if (routing.mode === 'whitelist' && routing.whitelist.length === 0) {
    warnings.push('白名单为空：whitelist 模式下所有网站都会直连')
  }
  const both = routing.whitelist.filter((entry) => routing.blacklist.includes(entry))
  if (both.length > 0) warnings.push(`同时出现在白名单与黑名单：${both.join(', ')}（黑名单优先，走直连）`)

  const probe = merged.probe
  probe.latencyUrl = normalizeProbeUrl(probe.latencyUrl, DEFAULT_CONFIG.probe.latencyUrl, 'probe.latencyUrl', errors)
  probe.ipUrl = normalizeProbeUrl(probe.ipUrl, DEFAULT_CONFIG.probe.ipUrl, 'probe.ipUrl', errors)
  probe.timeoutMs = asInt(probe.timeoutMs, DEFAULT_CONFIG.probe.timeoutMs)
  probe.intervalMinutes = asInt(probe.intervalMinutes, DEFAULT_CONFIG.probe.intervalMinutes)
  if (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs < 1000 || probe.timeoutMs > 30000) {
    errors.push({ field: 'probe.timeoutMs', message: '探测超时必须是 1000..30000 毫秒' })
  }
  if (!Number.isInteger(probe.intervalMinutes) || probe.intervalMinutes < 1 || probe.intervalMinutes > 60) {
    errors.push({ field: 'probe.intervalMinutes', message: '自动探测间隔必须是 1..60 分钟' })
  }

  const profile = merged.profile
  profile.shareLink = asString(profile.shareLink, '')
  profile.node = null
  profile.name = ''
  if (profile.shareLink) {
    try {
      const parsed = normalizeNode(parseShareLink(profile.shareLink))
      validateNode(parsed, errors, warnings)
      if (!errors.some((entry) => entry.field.startsWith('profile.'))) {
        profile.node = parsed
        profile.name = parsed.id
      }
    } catch (error) {
      errors.push({ field: 'profile.shareLink', message: String(error?.message ?? error) })
    }
  } else if (merged.enabled) {
    warnings.push('尚未导入 VLESS 链接：扩展只设置浏览器代理，前提是 Xray 内核已由 DSH-2Xray / v2rayN 等程序提供')
  }

  return { config: merged, errors, warnings }
}

/** Deep-merge a settings patch into an already-normalized config. */
export function applyConfigPatch(config, patch) {
  return merge(clone(config), isObject(patch) ? patch : {})
}
