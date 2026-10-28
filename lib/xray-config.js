/**
 * Pure builder for the xray-core client config. No I/O, no logging of secrets:
 * the caller writes the result to disk and only ever logs its hash.
 *
 * Single node (the legacy `server.*` shape): one VLESS outbound and a
 * catch-all routing rule straight to it — the same config this plugin has
 * always produced.
 *
 * Multiple nodes (`nodes[]`): one outbound per node plus a balancer. The
 * balancer is the runtime switch point: `RoutingService.OverrideBalancerTarget`
 * pins it to one outbound without touching the process. Outbound configs are
 * static because `HandlerService.AddOutbound` would require protobuf-encoding
 * `OutboundHandlerConfig` (TypedMessage sender/proxy settings) on the Node
 * side, which is far more fragile than a two-string override.
 *
 * The control plane (`control.enabled`) adds the standard API inbound plus the
 * `api` routing rule, and optionally the stats counters.
 */

// Explicit RFC1918/loopback/link-local ranges instead of geoip:private: the
// latter needs geoip.dat beside the binary, and v2rayN's xray.exe keeps it one
// directory up, which fails -test with "failed to open geoip.dat".
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
const API_TAG = 'api'

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildOutbound(node) {
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
    // Write both spellings: current Xray reads `password` and new configs use
    // it, older builds still parse `publicKey`. Never write both empty.
    if (node.password) streamSettings.realitySettings.password = node.password
    if (node.publicKey) streamSettings.realitySettings.publicKey = node.publicKey
  } else if (node.security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: node.serverName,
      fingerprint: node.fingerprint,
    }
  }

  return {
    tag: node.tag,
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: node.address,
          port: node.port,
          users,
        },
      ],
    },
    streamSettings,
    // Vision already carries XUDP; mux only adds latency here.
    mux: { enabled: false },
  }
}

/**
 * Build the xray-core JSON config.
 *
 * @param {object} config - normalized config from `normalizeConfig()`.
 * @returns {object} xray-core configuration object.
 */
export function buildXrayConfig(config) {
  const { inbound, routing, log, control } = config
  const nodes = config.nodes

  const inbounds = []
  const primaryProtocol = inbound.protocol === 'socks' ? 'socks' : 'http'
  inbounds.push({
    tag: `${primaryProtocol}-in`,
    listen: inbound.host,
    port: inbound.port,
    protocol: primaryProtocol,
    settings: primaryProtocol === 'socks' ? { auth: 'noauth', udp: false } : {},
    sniffing:
      primaryProtocol === 'socks'
        ? { enabled: true, destOverride: ['http', 'tls'], routeOnly: false }
        : { enabled: false },
  })

  if (inbound.socks.enabled) {
    inbounds.push({
      tag: 'socks-in',
      listen: inbound.socks.host,
      port: inbound.socks.port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: inbound.socks.udp },
      // Sniffing only ever belongs to an inbound. `routeOnly: false` resets the
      // destination to the recovered domain so the proxy outbound can resolve
      // it remotely instead of the client resolving it locally.
      sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false },
    })
  }

  if (control.enabled) {
    inbounds.push({
      tag: API_TAG,
      listen: control.host,
      port: control.port,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    })
  }

  const proxyOutbounds = nodes.map((node) => buildOutbound(node))
  const outbounds = [
    ...proxyOutbounds,
    {
      tag: 'direct',
      protocol: 'freedom',
      settings: {},
      streamSettings: {
        sockopt: {
          // Direct domains resolve through the system resolver, which is where
          // split-horizon/VPN/internal DNS lives. Proxy traffic keeps local DNS
          // at zero because the proxy outbound resolves remotely.
          domainStrategy: 'AsIs',
        },
      },
    },
    { tag: 'block', protocol: 'blackhole' },
  ]

  const rules = []
  if (control.enabled) {
    rules.push({ type: 'field', inboundTag: [API_TAG], outboundTag: API_TAG })
  }
  if (routing.blockAds) {
    rules.push({ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' })
  }
  rules.push({ type: 'field', ip: PRIVATE_IP_RULES, outboundTag: 'direct' })

  const bypassDomains = dedupe(routing.bypassDomains)
  if (bypassDomains.length > 0) {
    // A trailing dot entry matches the domain and every subdomain in Xray's
    // domain matcher; `geosite:cn` is opt-in because a catch-all would
    // otherwise make the second routing pass unreachable.
    rules.push({ type: 'field', domain: bypassDomains.map((entry) => `domain:${entry}`), outboundTag: 'direct' })
  }

  if (routing.geositeCn) {
    rules.push({ type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' })
  }

  const balancers = []
  if (nodes.length > 1) {
    balancers.push({
      tag: control.balancerTag,
      // Every node is a candidate; the runtime override pins one, and until an
      // override lands the strategy picks deterministically enough to be
      // usable.
      selector: nodes.map((node) => `^${escapeRegExp(node.tag)}$`),
      strategy: { type: 'random' },
    })
    rules.push({ type: 'field', network: 'tcp,udp', balancerTag: control.balancerTag })
  } else {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: nodes[0].tag })
  }

  const policy = {
    levels: { '0': { handshake: 8, connIdle: 600 } },
  }
  if (control.enabled && control.stats) {
    policy.system = {
      statsInboundUplink: true,
      statsInboundDownlink: true,
      statsOutboundUplink: true,
      statsOutboundDownlink: true,
    }
  }

  const built = {
    log: {
      loglevel: log.level,
      access: 'none',
      dnsLog: false,
    },
    // Keep connections alive past the harness' 300s stream idle watchdog so
    // Xray never sends the clean FIN that becomes a non-retryable
    // STREAM_CLOSED in the model provider.
    policy,
    inbounds,
    outbounds,
    routing: {
      domainStrategy: 'AsIs',
      rules,
      ...(balancers.length > 0 ? { balancers } : {}),
    },
  }

  if (control.enabled) {
    built.api = { tag: API_TAG, services: control.services }
    if (control.stats) built.stats = {}
  }

  return built
}

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
