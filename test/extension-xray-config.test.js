import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInbound, buildOutbound, buildXrayConfig, buildXrayConfigFromConfig, xrayRunCommand } from '../chrome-extension/lib/xray-config.js'
import { normalizeConfig } from '../chrome-extension/lib/config.js'

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

function nodeFrom(link = REALITY) {
  const { config, errors } = normalizeConfig({ profile: { shareLink: link } })
  assert.deepEqual(errors, [])
  return config.profile.node
}

function configFor(mode) {
  return normalizeConfig({
    enabled: true,
    profile: { shareLink: REALITY },
    routing: { mode, whitelist: ['github.com', 'google.com'], blacklist: ['deepseek.com'] },
  }).config
}

test('buildOutbound emits VLESS Vision REALITY with both key spellings', () => {
  const outbound = buildOutbound(nodeFrom())
  assert.equal(outbound.tag, 'proxy')
  assert.equal(outbound.protocol, 'vless')
  assert.equal(outbound.settings.vnext[0].address, 'hk.example.com')
  assert.equal(outbound.settings.vnext[0].port, 443)
  assert.equal(outbound.settings.vnext[0].users[0].id, '11111111-2222-4333-8444-555555555555')
  assert.equal(outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision')
  assert.equal(outbound.streamSettings.network, 'raw')
  assert.equal(outbound.streamSettings.security, 'reality')
  assert.equal(outbound.streamSettings.realitySettings.serverName, 'www.example.com')
  assert.equal(outbound.streamSettings.realitySettings.password, KEY)
  assert.equal(outbound.streamSettings.realitySettings.publicKey, KEY)
  assert.equal(outbound.mux.enabled, false)
})

test('HTTP inbound mirrors the extension proxy endpoint', () => {
  const inbound = buildInbound({ protocol: 'http', host: '127.0.0.1', port: 20808 })
  assert.deepEqual(inbound, {
    tag: 'http-in',
    listen: '127.0.0.1',
    port: 20808,
    protocol: 'http',
    settings: {},
    sniffing: { enabled: false },
  })
})

test('SOCKS inbound carries sniffing for domain recovery', () => {
  const inbound = buildInbound({ protocol: 'socks', host: '127.0.0.1', port: 20809 })
  assert.equal(inbound.protocol, 'socks')
  assert.equal(inbound.settings.auth, 'noauth')
  assert.equal(inbound.sniffing.enabled, true)
  assert.deepEqual(inbound.sniffing.destOverride, ['http', 'tls'])
})

test('global mode: blacklist direct first, private IPs direct, catch-all proxy', () => {
  const built = buildXrayConfig({
    node: nodeFrom(),
    proxy: { protocol: 'http', host: '127.0.0.1', port: 20808 },
    routing: { mode: 'global', whitelist: ['github.com'], blacklist: ['deepseek.com'], bypassDomains: ['lan'] },
  })
  assert.equal(built.routing.domainStrategy, 'AsIs')
  assert.deepEqual(built.outbounds.map((outbound) => outbound.tag), ['proxy', 'direct', 'block'])
  assert.deepEqual(built.routing.rules[0], {
    type: 'field',
    domain: ['domain:deepseek.com'],
    outboundTag: 'direct',
  })
  assert.equal(built.routing.rules[1].ip.includes('192.168.0.0/16'), true)
  assert.deepEqual(built.routing.rules.at(-1), { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' })
})

test('whitelist mode adds a proxy rule and falls back to direct', () => {
  const built = buildXrayConfig({
    node: nodeFrom(),
    proxy: { protocol: 'http', host: '127.0.0.1', port: 20808 },
    routing: {
      mode: 'whitelist',
      whitelist: ['github.com', 'deepseek.com'],
      blacklist: ['deepseek.com'],
      bypassDomains: [],
    },
  })
  const proxyRule = built.routing.rules.find((rule) => rule.outboundTag === 'proxy')
  assert.deepEqual(proxyRule.domain, ['domain:github.com'])
  assert.deepEqual(built.routing.rules.at(-1), { type: 'field', network: 'tcp,udp', outboundTag: 'direct' })
})

test('cn-direct mode adds geosite/geoip rules and IPIfNonMatch', () => {
  const built = buildXrayConfig({
    node: nodeFrom(),
    proxy: { protocol: 'http', host: '127.0.0.1', port: 20808 },
    routing: { mode: 'cn-direct', whitelist: [], blacklist: [], bypassDomains: [] },
  })
  assert.equal(built.routing.domainStrategy, 'IPIfNonMatch')
  assert.equal(
    built.routing.rules.some((rule) => Array.isArray(rule.domain) && rule.domain.includes('geosite:cn')),
    true,
  )
  assert.equal(
    built.routing.rules.some((rule) => Array.isArray(rule.ip) && rule.ip.includes('geoip:cn')),
    true,
  )
})

test('buildXrayConfigFromConfig uses the active profile and is JSON-safe', () => {
  const config = configFor('global')
  const built = buildXrayConfigFromConfig(config)
  assert.equal(built.inbounds[0].port, 20808)
  const text = JSON.stringify(built)
  assert.ok(text.length > 500)
  assert.equal(JSON.parse(text).outbounds[0].protocol, 'vless')
})

test('buildXrayConfigFromConfig returns null without a node', () => {
  const { config } = normalizeConfig({})
  assert.equal(buildXrayConfigFromConfig(config), null)
})

test('missing node throws a named error', () => {
  assert.throws(() => buildXrayConfig({ node: null }), /VLESS/)
})

test('xrayRunCommand points at the generated file', () => {
  assert.equal(xrayRunCommand('config.json'), 'xray run -c config.json')
})
