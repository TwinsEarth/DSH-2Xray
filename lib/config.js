/**
 * Config normalization and validation for dsh-2xray.
 *
 * The plugin deliberately exports no `Config` schema: a schema failure at load
 * time would deactivate the row and hide the diagnostics from the user. Instead
 * normalization returns `{ config, errors, warnings }`; the supervisor turns a
 * non-empty `errors` array into a `failed(config-invalid)` state and keeps the
 * plugin loaded so the reason stays readable in the log and `status.json`.
 *
 * Two node shapes are accepted:
 *   - `server.*`   legacy single node (still the shortest config);
 *   - `nodes[]`    one entry per outbound, switched at runtime through a
 *                  balancer override on the Xray control plane;
 *   - `shareLink` / `shareLinks`  standard `vless://` links (the same text a
 *                  QR code carries), parsed into nodes.
 */

import { parseShareLinks } from './share-link.js'

export const DEFAULT_CONFIG = {
  enabled: false,
  server: {
    address: '',
    port: 443,
    uuid: '',
    flow: 'xtls-rprx-vision',
    serverName: '',
    // REALITY `password` is the current field name; `publicKey` is the legacy
    // one. Both are written to the xray config when provided so one config
    // works across the versions that renamed the field.
    password: '',
    publicKey: '',
    shortId: '',
    fingerprint: 'chrome',
    spiderX: '/',
    network: 'raw',
    security: 'reality',
  },
  nodes: [],
  /** Paste one standard `vless://` share link (same text a QR code carries). */
  shareLink: '',
  /** Or paste several; each becomes a node with its fragment name as the id. */
  shareLinks: [],
  activeNode: '',
  inbound: {
    protocol: 'http',
    host: '127.0.0.1',
    port: 20808,
    socks: { enabled: false, host: '127.0.0.1', port: 20809, udp: false },
  },
  takeover: 'auto',
  noProxy: '',
  routing: {
    bypassDomains: ['localhost', 'local', 'lan', 'internal', 'corp', 'home.arpa'],
    blockAds: false,
    geositeCn: false,
  },
  control: {
    // Off by default: a single-node config needs no API listener, and enabling
    // it opens one more loopback port. Multi-node switching requires it.
    enabled: false,
    host: '127.0.0.1',
    port: 10085,
    services: ['HandlerService', 'StatsService', 'RoutingService'],
    stats: true,
    balancerTag: 'active',
    timeoutMs: 3000,
  },
  binary: { path: '', dataDir: '' },
  lifecycle: {
    startTimeoutMs: 15000,
    stopGraceMs: 3000,
    maxRestarts: 5,
    backoffMs: 500,
    backoffMaxMs: 30000,
    healthIntervalMs: 30000,
    unhealthyThreshold: 3,
    probeTimeoutMs: 3000,
  },
  functionalProbe: {
    enabled: true,
    // Reachable from mainland networks through most nodes; gstatic is often
    // blocked and would misreport a working tunnel as failed.
    url: 'http://cp.cloudflare.com/generate_204',
    timeoutMs: 8000,
  },
  log: { level: 'warning' },
}

const FLOWS = new Set(['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'])
const NETWORKS = new Set(['raw', 'tcp'])
const SECURITIES = new Set(['reality', 'tls', 'none'])
const TAKEOVERS = new Set(['auto', 'force', 'off'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/
const SHORT_ID_RE = /^(?:[0-9a-fA-F]{2})*$/

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

function asStringList(value, fallback) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return clone(fallback)
}

export function sanitizeTag(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_')
}

function normalizeEndpoint(raw, index) {
  const node = merge(clone(DEFAULT_CONFIG.server), raw)
  const id = asString(raw?.id, '') || (index === undefined ? 'default' : `node-${index + 1}`)
  const network = asString(node.network, 'raw')
  return {
    id,
    tag: asString(raw?.tag, '') || (index === undefined ? 'proxy' : `proxy-${sanitizeTag(id)}`),
    address: asString(node.address, ''),
    port: asInt(node.port, 443),
    uuid: asString(node.uuid, ''),
    flow: asString(node.flow, DEFAULT_CONFIG.server.flow),
    serverName: asString(node.serverName, ''),
    password: asString(node.password, ''),
    publicKey: asString(node.publicKey, ''),
    shortId: asString(node.shortId, ''),
    fingerprint: asString(node.fingerprint, 'chrome'),
    spiderX: asString(node.spiderX, '/'),
    network: network === 'tcp' ? 'raw' : network,
    security: asString(node.security, 'reality'),
  }
}

function validateEndpoint(endpoint, prefix, errors, warnings) {
  if (!endpoint.address) errors.push({ field: `${prefix}.address`, message: '服务端地址不能为空' })
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    errors.push({ field: `${prefix}.port`, message: '服务端端口必须是 1..65535 的整数' })
  }
  if (!endpoint.uuid) errors.push({ field: `${prefix}.uuid`, message: 'VLESS uuid 不能为空' })
  else if (!UUID_RE.test(endpoint.uuid) && endpoint.uuid.length > 30) {
    errors.push({ field: `${prefix}.uuid`, message: 'uuid 既不是标准 UUID，也超过 30 字节（VLESS 会映射为 UUIDv5）' })
  } else if (!UUID_RE.test(endpoint.uuid)) {
    warnings.push(`${prefix}.uuid 不是标准 UUID，将按 VLESS 字符串 id 处理`)
  }

  if (!NETWORKS.has(endpoint.network)) {
    errors.push({ field: `${prefix}.network`, message: `network 只支持 raw/tcp，收到 ${endpoint.network}` })
  }
  if (!SECURITIES.has(endpoint.security)) {
    errors.push({ field: `${prefix}.security`, message: `security 只支持 reality/tls/none，收到 ${endpoint.security}` })
  }
  if (!FLOWS.has(endpoint.flow)) {
    errors.push({ field: `${prefix}.flow`, message: `flow 只支持 ""/xtls-rprx-vision/xtls-rprx-vision-udp443，收到 ${endpoint.flow}` })
  }
  if (endpoint.flow !== '' && (!NETWORKS.has(endpoint.network) || !['reality', 'tls'].includes(endpoint.security))) {
    // `-test` does not catch this; the first request fails with
    // "XTLS only supports TLS and REALITY directly for now."
    errors.push({ field: `${prefix}.flow`, message: 'flow 非空时 network 必须是 raw/tcp 且 security 必须是 reality/tls' })
  }

  if (endpoint.security === 'reality') {
    if (!endpoint.serverName) errors.push({ field: `${prefix}.serverName`, message: 'REALITY 必须提供 serverName' })
    if (!endpoint.password && !endpoint.publicKey) {
      errors.push({ field: `${prefix}.password`, message: 'REALITY 必须提供 password（或旧字段 publicKey）' })
    }
    for (const candidate of [endpoint.password, endpoint.publicKey]) {
      if (candidate && !BASE64URL_32_RE.test(candidate)) {
        errors.push({ field: `${prefix}.password`, message: 'REALITY 公钥必须是 43 字符 base64url（32 字节 X25519），请用 xray x25519 生成' })
        break
      }
    }
    if (endpoint.shortId && (!SHORT_ID_RE.test(endpoint.shortId) || endpoint.shortId.length > 16)) {
      errors.push({ field: `${prefix}.shortId`, message: 'shortId 必须是偶数长度的 hex，且不超过 16 个字符' })
    }
    if (!endpoint.fingerprint) errors.push({ field: `${prefix}.fingerprint`, message: 'REALITY 必须提供 uTLS 指纹，例如 chrome' })
    if (!endpoint.spiderX.startsWith('/')) errors.push({ field: `${prefix}.spiderX`, message: 'spiderX 必须以 / 开头' })
  } else if (endpoint.security === 'tls') {
    if (!endpoint.serverName) errors.push({ field: `${prefix}.serverName`, message: 'TLS 必须提供 serverName（SNI）' })
  }
}

/**
 * Schemastery resolves volatile fields to `{ get }` references. Normalization
 * must see their values, so unwrap them before merging defaults.
 */
function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'get' && typeof value.get === 'function') {
    return unwrapVolatile(value.get())
  }
  const out = {}
  for (const key of keys) out[key] = unwrapVolatile(value[key])
  return out
}

/**
 * Normalize a raw `config:` block from `cordis.patch.yml` into the shape the
 * rest of the plugin consumes.
 *
 * @param raw - the row config, possibly `undefined`.
 * @returns normalized config plus field-level validation results.
 */
export function normalizeConfig(raw) {
  raw = unwrapVolatile(raw)
  const errors = []
  const warnings = []
  const merged = merge(clone(DEFAULT_CONFIG), raw)

  merged.enabled = asBool(merged.enabled, DEFAULT_CONFIG.enabled)
  merged.takeover = asString(merged.takeover, 'auto')
  merged.noProxy = asString(merged.noProxy, '')
  merged.activeNode = asString(merged.activeNode, '')

  const server = normalizeEndpoint(merged.server, undefined)
  merged.server = { ...server }

  const rawNodes = Array.isArray(merged.nodes) ? merged.nodes : []
  const entries = rawNodes.map((node, index) => ({
    node: normalizeEndpoint(node, index),
    prefix: `nodes[${index}]`,
  }))

  // Share links are the paste/scan import path: the same URL text a QR code
  // carries. `shareLinks` wins over the singular `shareLink` when both are set.
  const linkValues = []
  if (Array.isArray(merged.shareLinks)) linkValues.push(...merged.shareLinks)
  else if (typeof merged.shareLinks === 'string' && merged.shareLinks.trim() !== '') linkValues.push(merged.shareLinks)
  if (linkValues.length === 0 && typeof merged.shareLink === 'string' && merged.shareLink.trim() !== '') {
    linkValues.push(merged.shareLink)
  }
  const parsedLinks = parseShareLinks(linkValues)
  for (const error of parsedLinks.errors) errors.push(error)
  for (const warning of parsedLinks.warnings) warnings.push(warning)
  parsedLinks.nodes.forEach((node, index) => {
    entries.push({
      node: normalizeEndpoint(node, rawNodes.length + index),
      prefix: `shareLinks[${index}]`,
    })
  })

  const nodes = entries.map((entry) => entry.node)
  if (nodes.length > 0) {
    for (const entry of entries) {
      validateEndpoint(entry.node, entry.prefix, errors, warnings)
    }
    const seenTags = new Set()
    for (const entry of entries) {
      entry.node.tag = sanitizeTag(entry.node.tag) || `proxy-${sanitizeTag(entry.node.id)}`
      if (seenTags.has(entry.node.tag)) {
        errors.push({ field: `${entry.prefix}.tag`, message: `outbound tag 重复：${entry.node.tag}` })
      }
      seenTags.add(entry.node.tag)
    }
    const match = merged.activeNode
      ? nodes.find((node) => node.id === merged.activeNode || node.tag === merged.activeNode)
      : undefined
    if (merged.activeNode && !match) {
      warnings.push(`activeNode ${merged.activeNode} 不在节点中，回退到第一个节点`)
    }
    merged.activeNode = (match ?? nodes[0]).tag
  } else {
    validateEndpoint(merged.server, 'server', errors, warnings)
    merged.activeNode = 'proxy'
    nodes.push({ ...merged.server, id: 'default', tag: 'proxy' })
  }
  merged.nodes = nodes

  const inbound = merged.inbound
  inbound.protocol = asString(inbound.protocol, 'http')
  inbound.host = asString(inbound.host, '127.0.0.1')
  inbound.port = asInt(inbound.port, DEFAULT_CONFIG.inbound.port)
  const socks = inbound.socks
  socks.enabled = asBool(socks.enabled, false)
  socks.host = asString(socks.host, '127.0.0.1')
  socks.port = asInt(socks.port, DEFAULT_CONFIG.inbound.socks.port)
  socks.udp = asBool(socks.udp, false)

  merged.routing.bypassDomains = asStringList(merged.routing.bypassDomains, DEFAULT_CONFIG.routing.bypassDomains)
  merged.routing.blockAds = asBool(merged.routing.blockAds, false)
  merged.routing.geositeCn = asBool(merged.routing.geositeCn, false)

  const control = merged.control
  control.enabled = asBool(control.enabled, false)
  control.host = asString(control.host, '127.0.0.1')
  control.port = asInt(control.port, DEFAULT_CONFIG.control.port)
  control.services = asStringList(control.services, DEFAULT_CONFIG.control.services)
  control.stats = asBool(control.stats, true)
  control.balancerTag = sanitizeTag(asString(control.balancerTag, 'active')) || 'active'
  control.timeoutMs = asInt(control.timeoutMs, DEFAULT_CONFIG.control.timeoutMs)

  merged.binary.path = asString(merged.binary.path, '')
  merged.binary.dataDir = asString(merged.binary.dataDir, '')

  const life = merged.lifecycle
  for (const key of Object.keys(DEFAULT_CONFIG.lifecycle)) {
    life[key] = asInt(life[key], DEFAULT_CONFIG.lifecycle[key])
  }

  merged.functionalProbe.enabled = asBool(merged.functionalProbe.enabled, true)
  merged.functionalProbe.url = asString(merged.functionalProbe.url, DEFAULT_CONFIG.functionalProbe.url)
  merged.functionalProbe.timeoutMs = asInt(merged.functionalProbe.timeoutMs, DEFAULT_CONFIG.functionalProbe.timeoutMs)

  merged.log.level = asString(merged.log.level, 'warning')

  // ---- semantic validation -------------------------------------------------
  if (inbound.protocol !== 'http' && inbound.protocol !== 'socks') {
    errors.push({ field: 'inbound.protocol', message: 'inbound.protocol 只支持 http 或 socks' })
  }
  if (!LOOPBACK_HOSTS.has(inbound.host)) {
    errors.push({ field: 'inbound.host', message: '入站必须绑定回环地址，127.0.0.1 / ::1 / localhost' })
  }
  if (!Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) {
    errors.push({ field: 'inbound.port', message: '入站端口必须是 1..65535 的整数' })
  }
  if (socks.enabled) {
    if (!LOOPBACK_HOSTS.has(socks.host)) {
      errors.push({ field: 'inbound.socks.host', message: 'SOCKS 入站必须绑定回环地址' })
    }
    if (!Number.isInteger(socks.port) || socks.port < 1 || socks.port > 65535) {
      errors.push({ field: 'inbound.socks.port', message: 'SOCKS 入站端口必须是 1..65535 的整数' })
    }
    if (socks.port === inbound.port) {
      errors.push({ field: 'inbound.socks.port', message: 'SOCKS 入站端口不能与 HTTP 入站端口相同' })
    }
  }
  if (!TAKEOVERS.has(merged.takeover)) {
    errors.push({ field: 'takeover', message: `takeover 只支持 auto/force/off，收到 ${merged.takeover}` })
  }
  for (const [key, value] of Object.entries(life)) {
    if (!Number.isInteger(value) || value < 0) {
      errors.push({ field: `lifecycle.${key}`, message: `${key} 必须是非负整数` })
    }
  }
  if (!['debug', 'info', 'warning', 'error', 'none'].includes(merged.log.level)) {
    warnings.push(`log.level ${merged.log.level} 不是标准值，将原样传给 xray`)
  }
  if (merged.functionalProbe.enabled) {
    try {
      const probeUrl = new URL(merged.functionalProbe.url)
      if (probeUrl.protocol !== 'http:') {
        warnings.push('functionalProbe.url 建议使用 http:// 的 204 地址；https 会额外做一次 TLS 建连')
      }
    } catch {
      errors.push({ field: 'functionalProbe.url', message: 'functionalProbe.url 不是合法 URL' })
    }
  }

  if (control.enabled) {
    if (!LOOPBACK_HOSTS.has(control.host)) {
      errors.push({ field: 'control.host', message: 'gRPC API 必须绑定回环地址' })
    }
    if (!Number.isInteger(control.port) || control.port < 1 || control.port > 65535) {
      errors.push({ field: 'control.port', message: 'gRPC API 端口必须是 1..65535 的整数' })
    }
    if (control.port === inbound.port || (socks.enabled && control.port === socks.port)) {
      errors.push({ field: 'control.port', message: 'gRPC API 端口不能与任何入站端口相同' })
    }
    if (control.services.length === 0) {
      errors.push({ field: 'control.services', message: 'control.services 不能为空' })
    }
    for (const service of control.services) {
      if (!['HandlerService', 'StatsService', 'RoutingService', 'LoggerService'].includes(service)) {
        warnings.push(`control.services 含未知服务 ${service}，xray 可能拒绝启动`)
      }
    }
    if (!Number.isInteger(control.timeoutMs) || control.timeoutMs <= 0) {
      errors.push({ field: 'control.timeoutMs', message: 'control.timeoutMs 必须是正整数' })
    }
  }
  if (nodes.length > 1 && !control.enabled) {
    warnings.push('配置了多个 nodes 但 control.enabled=false，运行时切换节点不可用；将使用第一个节点')
  }

  return { config: merged, errors, warnings }
}

export function isLoopbackHost(host) {
  const normalized = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1' || normalized === '::' || normalized === '0.0.0.0') return true
  return /^127\./.test(normalized)
}
