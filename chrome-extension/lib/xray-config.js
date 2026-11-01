/**
 * Pure builder for a standalone xray-core client config.
 *
 * Ported from DSH-2Xray `lib/xray-config.js`, reduced to what the extension can
 * manage: one VLESS outbound (the active profile), one local inbound matching
 * the extension proxy protocol, routing rules mirroring the PAC.
 *
 * The extension never runs this config itself — it generates it so the user can
 * start/refresh the Xray core with the exact node and routing the browser uses.
 */

const PRIVATE_IP_RULES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]

function dedupe(entries) {
  const seen = new Set()
  const out = []
  for (const raw of entries ?? []) {
    const entry = String(raw).trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function domainRules(entries) {
  return dedupe(entries).map((entry) => `domain:${entry}`)
}

/** VLESS outbound in the same shape DSH-2Xray generates. */
export function buildOutbound(node) {
  if (!node) throw new Error('没有可用的 VLESS 节点')
  const users = [{ id: node.uuid, encryption: 'none' }]
  if (node.flow) users[0].flow = node.flow

  const streamSettings = {
    network: node.network === 'tcp' ? 'raw' : node.network,
    security: node.security,
  }

  if (node.security === 'reality') {
    streamSettings.realitySettings = {
      serverName: node.serverName,
      fingerprint: node.fingerprint,
      shortId: node.shortId,
      spiderX: node.spiderX,
      show: false,
    }
    if (node.password) streamSettings.realitySettings.password = node.password
    if (node.publicKey) streamSettings.realitySettings.publicKey = node.publicKey
  } else if (node.security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: node.serverName,
      fingerprint: node.fingerprint,
    }
  }

  return {
    tag: 'proxy',
    protocol: 'vless',
    settings: { vnext: [{ address: node.address, port: node.port, users }] },
    streamSettings,
    mux: { enabled: false },
  }
}

/** Local inbound matching the extension's proxy protocol. */
export function buildInbound(proxy = {}) {
  const protocol = proxy.protocol === 'socks' ? 'socks' : 'http'
  const host = proxy.host || '127.0.0.1'
  const port = Number(proxy.port) || 20808
  if (protocol === 'socks') {
    return {
      tag: 'socks-in',
      listen: host,
      port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: false },
      sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
    }
  }
  return {
    tag: 'http-in',
    listen: host,
    port,
    protocol: 'http',
    settings: {},
    sniffing: { enabled: false },
  }
}

/**
 * @param {object} options
 * @param {object} options.node - normalized VLESS node.
 * @param {object} options.proxy - {protocol, host, port}.
 * @param {object} options.routing - {mode, whitelist, blacklist, bypassDomains}.
 * @param {string} [options.logLevel]
 * @returns {object} xray-core JSON config.
 */
export function buildXrayConfig({ node, proxy, routing, logLevel = 'warning' }) {
  if (!node) throw new Error('没有可用的 VLESS 节点：请先导入 vless:// 链接')
  const mode = routing?.mode ?? 'global'
  const blacklist = dedupe(routing?.blacklist ?? [])
  const whitelist = dedupe(routing?.whitelist ?? []).filter((entry) => !blacklist.includes(entry))
  const bypass = dedupe(routing?.bypassDomains ?? [])

  const rules = []
  if (blacklist.length > 0) {
    // Highest priority: blacklisted hosts stay direct even in whitelist mode.
    rules.push({ type: 'field', domain: domainRules(blacklist), outboundTag: 'direct' })
  }
  if (mode === 'whitelist' && whitelist.length > 0) {
    rules.push({ type: 'field', domain: domainRules(whitelist), outboundTag: 'proxy' })
  }
  rules.push({ type: 'field', ip: PRIVATE_IP_RULES, outboundTag: 'direct' })
  if (bypass.length > 0) {
    rules.push({ type: 'field', domain: domainRules(bypass), outboundTag: 'direct' })
  }
  if (mode === 'cn-direct') {
    rules.push({ type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' })
    rules.push({ type: 'field', ip: ['geoip:cn'], outboundTag: 'direct' })
  }
  if (mode === 'whitelist') {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: 'direct' })
  } else {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' })
  }

  return {
    log: { loglevel: logLevel, access: 'none', dnsLog: false },
    inbounds: [buildInbound(proxy)],
    outbounds: [
      buildOutbound(node),
      {
        tag: 'direct',
        protocol: 'freedom',
        settings: {},
        streamSettings: { sockopt: { domainStrategy: 'AsIs' } },
      },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      // cn-direct resolves unmatched domains so geoip:cn can match.
      domainStrategy: mode === 'cn-direct' ? 'IPIfNonMatch' : 'AsIs',
      rules,
    },
  }
}

/** Convenience: build from a normalized extension config; null without a node. */
export function buildXrayConfigFromConfig(config) {
  if (!config?.profile?.node) return null
  return buildXrayConfig({
    node: config.profile.node,
    proxy: config.proxy,
    routing: config.routing,
  })
}

/** Suggested shell command for the generated file. */
export function xrayRunCommand(fileName = 'config.json') {
  return `xray run -c ${fileName}`
}
