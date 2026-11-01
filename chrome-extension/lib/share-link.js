/**
 * Parse and build `vless://` share links.
 *
 * Ported from DSH-2Xray `lib/share-link.js` so the browser extension and the
 * host plugin accept exactly the same link text (including what a QR code
 * carries). Only VLESS is supported: the extension generates a VLESS outbound.
 */

export class ShareLinkError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ShareLinkError'
    this.code = code
  }
}

const SUPPORTED_SCHEMES = new Set(['vless:'])
const KNOWN_SCHEMES = new Set([
  'vmess:',
  'trojan:',
  'ss:',
  'socks:',
  'http:',
  'https:',
  'hysteria2:',
  'tuic:',
])

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * @param {string} link - `vless://...` share link.
 * @param {{index?: number}} [options]
 * @returns {object} node shape consumed by `normalizeConfig`.
 */
export function parseShareLink(link, { index = 0 } = {}) {
  const trimmed = String(link ?? '').trim()
  if (!trimmed) throw new ShareLinkError('invalid-link', '分享链接为空')

  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new ShareLinkError('invalid-link', `不是合法 URL：${trimmed.slice(0, 40)}…`)
  }

  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    if (KNOWN_SCHEMES.has(url.protocol)) {
      throw new ShareLinkError(
        'unsupported-scheme',
        `暂不支持 ${url.protocol.replace(':', '')} 分享链接；扩展只生成 VLESS 出站，请改用 vless:// 链接`,
      )
    }
    throw new ShareLinkError('unsupported-scheme', `未知的分享链接协议：${url.protocol}`)
  }

  const uuid = decode(url.username)
  const address = url.hostname.replace(/^\[|\]$/g, '')
  if (!uuid) throw new ShareLinkError('invalid-link', 'vless 链接缺少 uuid')
  if (!address) throw new ShareLinkError('invalid-link', 'vless 链接缺少服务器地址')

  const port = url.port ? Number(url.port) : 443
  const query = url.searchParams
  const security = (query.get('security') ?? 'none').toLowerCase()
  const rawNetwork = (query.get('type') ?? 'tcp').toLowerCase()
  const network = rawNetwork === 'tcp' ? 'raw' : rawNetwork
  const publicKey = query.get('pbk') ?? query.get('publicKey') ?? ''
  const name = decode(url.hash.replace(/^#/, '')).trim()

  const node = {
    id: name || `link-${index + 1}`,
    address,
    port,
    uuid,
    flow: query.get('flow') ?? (security === 'none' ? '' : 'xtls-rprx-vision'),
    serverName: query.get('sni') ?? query.get('host') ?? '',
    // `password` is the current Xray field, `publicKey` the legacy one; writing
    // both keeps generated configs valid across Xray versions.
    password: publicKey,
    publicKey,
    shortId: query.get('sid') ?? '',
    fingerprint: query.get('fp') ?? 'chrome',
    spiderX: query.get('spx') ?? '/',
    network,
    security,
  }

  if (security === 'none') {
    node.flow = query.get('flow') ?? ''
    node.serverName = ''
    node.shortId = ''
  }

  return node
}

/** Parse a list of links, keeping failures addressable per index. */
export function parseShareLinks(links) {
  const nodes = []
  const errors = []
  const warnings = []
  const list = Array.isArray(links) ? links : [links]
  for (let index = 0; index < list.length; index++) {
    const link = list[index]
    if (typeof link !== 'string' || link.trim() === '') {
      errors.push({ field: `shareLinks[${index}]`, message: '分享链接必须是非空字符串' })
      continue
    }
    try {
      const node = parseShareLink(link, { index })
      if (!node.serverName && node.security !== 'none') {
        warnings.push(`shareLinks[${index}] 缺少 sni，REALITY/TLS 需要 serverName`)
      }
      nodes.push(node)
    } catch (error) {
      errors.push({ field: `shareLinks[${index}]`, message: error.message })
    }
  }
  return { nodes, errors, warnings }
}

/**
 * Rebuild a standard share link from a normalized node. Used by the popup's
 * "复制链接" and by the QR code shown next to the current profile.
 */
export function buildShareLink(node) {
  if (!node || !node.address || !node.uuid) throw new ShareLinkError('invalid-link', '节点缺少地址或 uuid')
  const query = new URLSearchParams()
  query.set('encryption', 'none')
  query.set('type', node.network === 'raw' || !node.network ? 'tcp' : node.network)
  if (node.security === 'reality') {
    query.set('security', 'reality')
    if (node.serverName) query.set('sni', node.serverName)
    if (node.fingerprint) query.set('fp', node.fingerprint)
    if (node.password) query.set('pbk', node.password)
    if (node.shortId) query.set('sid', node.shortId)
    if (node.spiderX) query.set('spx', node.spiderX)
    if (node.flow) query.set('flow', node.flow)
  } else if (node.security === 'tls') {
    query.set('security', 'tls')
    if (node.serverName) query.set('sni', node.serverName)
    if (node.fingerprint) query.set('fp', node.fingerprint)
    if (node.flow) query.set('flow', node.flow)
  } else {
    query.set('security', 'none')
  }

  const host = node.address.includes(':') ? `[${node.address}]` : node.address
  const hash = node.id ? `#${encodeURIComponent(node.id)}` : ''
  return `vless://${encodeURIComponent(node.uuid)}@${host}:${Number(node.port) || 443}?${query.toString()}${hash}`
}
