import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'

function config(overrides = {}) {
  return normalizeConfig({
    enabled: true,
    server: {
      address: 'example.com',
      port: 443,
      uuid: '11111111-2222-4333-8444-555555555555',
      serverName: 'www.example.com',
      password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      shortId: 'ab12',
      ...overrides.server,
    },
    ...overrides.root,
  }).config
}

test('the HTTP inbound is loopback-only and uses the configured port', () => {
  const built = buildXrayConfig(config({ root: { inbound: { host: '127.0.0.1', port: 20808 } } }))
  assert.equal(built.inbounds[0].protocol, 'http')
  assert.equal(built.inbounds[0].listen, '127.0.0.1')
  assert.equal(built.inbounds[0].port, 20808)
  assert.equal(built.inbounds[0].tag, 'http-in')
})

test('VLESS outbound carries encryption none and the Vision flow', () => {
  const built = buildXrayConfig(config())
  const proxy = built.outbounds[0]
  assert.equal(proxy.protocol, 'vless')
  assert.equal(proxy.settings.vnext.length, 1)
  const user = proxy.settings.vnext[0].users[0]
  assert.equal(user.encryption, 'none')
  assert.equal(user.flow, 'xtls-rprx-vision')
  assert.equal(proxy.settings.vnext[0].address, 'example.com')
  assert.equal(proxy.settings.vnext[0].port, 443)
})

test('REALITY stream fields are the current names only', () => {
  const built = buildXrayConfig(config())
  const stream = built.outbounds[0].streamSettings
  assert.equal(stream.network, 'raw')
  assert.equal(stream.security, 'reality')
  assert.equal(stream.realitySettings.serverName, 'www.example.com')
  assert.equal(stream.realitySettings.password, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(stream.realitySettings.shortId, 'ab12')
  assert.equal(stream.realitySettings.fingerprint, 'chrome')
  assert.equal(stream.realitySettings.spiderX, '/')
  // client-side fields that Xray reads as "this is a server" must not appear
  assert.equal(stream.realitySettings.serverNames, undefined)
  assert.equal(stream.realitySettings.privateKey, undefined)
  assert.equal(stream.realitySettings.dest, undefined)
})

test('both legacy and current REALITY key names are written when both are set', () => {
  const built = buildXrayConfig(
    config({
      server: {
        password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    }),
  )
  assert.equal(built.outbounds[0].streamSettings.realitySettings.password, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(built.outbounds[0].streamSettings.realitySettings.publicKey, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
})

test('direct and block outbounds exist and the catch-all goes to proxy', () => {
  const built = buildXrayConfig(config())
  assert.deepEqual(
    built.outbounds.map((outbound) => outbound.tag),
    ['proxy', 'direct', 'block'],
  )
  const last = built.routing.rules.at(-1)
  assert.equal(last.outboundTag, 'proxy')
  assert.equal(last.network, 'tcp,udp')
})

test('private addresses and internal suffixes are routed direct', () => {
  const built = buildXrayConfig(config({ root: { routing: { bypassDomains: ['lan', 'corp'] } } }))
  const ipRule = built.routing.rules.find((rule) => rule.ip)
  assert.deepEqual(ipRule.ip, ['geoip:private'])
  const domainRule = built.routing.rules.find((rule) => rule.domain && rule.domain.some((entry) => entry.startsWith('domain:lan')))
  assert.deepEqual(domainRule.domain, ['domain:lan', 'domain:corp'])
})

test('a disabled socks inbound does not add a second listener', () => {
  const built = buildXrayConfig(config())
  assert.equal(built.inbounds.length, 1)
})

test('an enabled socks inbound is loopback and udp is opt-in', () => {
  const built = buildXrayConfig(
    config({ root: { inbound: { socks: { enabled: true, host: '127.0.0.1', port: 20809, udp: true } } } }),
  )
  const socks = built.inbounds.find((inbound) => inbound.protocol === 'socks')
  assert.equal(socks.port, 20809)
  assert.equal(socks.settings.udp, true)
})

test('a socks primary inbound replaces the http listener', () => {
  const built = buildXrayConfig(
    config({ root: { inbound: { protocol: 'socks', host: '127.0.0.1', port: 20809 } } }),
  )
  assert.equal(built.inbounds[0].protocol, 'socks')
  assert.equal(built.inbounds[0].tag, 'socks-in')
  assert.equal(built.inbounds[0].settings.auth, 'noauth')
})

test('connIdle outlives the harness stream idle watchdog', () => {
  const built = buildXrayConfig(config())
  assert.ok(built.policy.levels['0'].connIdle >= 600)
})

test('the config carries no access log', () => {
  const built = buildXrayConfig(config())
  assert.equal(built.log.access, 'none')
  assert.equal(built.log.loglevel, 'warning')
})

test('tls security produces tlsSettings instead of realitySettings', () => {
  const built = buildXrayConfig(
    config({ server: { security: 'tls', flow: 'xtls-rprx-vision', serverName: 'tls.example.com' } }),
  )
  const stream = built.outbounds[0].streamSettings
  assert.equal(stream.security, 'tls')
  assert.equal(stream.tlsSettings.serverName, 'tls.example.com')
  assert.equal(stream.realitySettings, undefined)
})
