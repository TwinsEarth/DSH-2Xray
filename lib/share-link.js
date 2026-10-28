/**
 * Parse proxy share links into the plugin's node shape.
 *
 * Only `vless://` is supported: the outbound builder currently emits VLESS
 * (Vision + REALITY). Other schemes are rejected with a named reason instead of
 * being half-translated into a config Xray would reject at startup.
 *
 * Supported link shape (standard Xray/v2rayN export):
 *
 *   vless://<uuid>@<host>:<port>?encryption=none&security=reality
 *     &sni=www.example.com&fp=chrome&pbk=<base64url>&sid=<hex>
 *     &spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong
 *
 * QR codes contain the same link text, so the parser is the one piece both the
 * "paste link" and "scan code" flows share.
 */

export class ShareLinkError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ShareLinkError'
    this.code = code
  }
}

const SUPPORTED_SCHEMES = new Set(['vless:'])
const KNOWN_SCHEMES = new Set(['vmess:', 'trojan:', 'ss:', 'socks:', 'http:', 'https:', 'hysteria2:', 'tuic:'])

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * @param {string} link - `vless://...` share link.
 * @param {object} [options]
 * @param {number} [options.index] - used for the fallback node id.
 * @returns {object} node config accepted by `normalizeConfig({ nodes: [...] })`.
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
        `暂不支持 ${url.protocol.replace(':', '')} 分享链接；当前只能生成 VLESS 出站，请改用 vless:// 链接或手写 nodes[]`,
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
    // both keeps the generated config valid across versions.
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

/**
 * Parse every entry and keep the failures addressable per item, so one bad
 * link does not hide the rest.
 *
 * @returns {{ nodes: object[], errors: {field: string, message: string}[], warnings: string[] }}
 */
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
