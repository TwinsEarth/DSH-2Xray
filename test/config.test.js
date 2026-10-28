import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'

function base(overrides = {}) {
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
  })
}

test('a complete REALITY config validates', () => {
  const { errors } = base()
  assert.deepEqual(errors, [])
})

test('missing server address / uuid are field-level errors, not throws', () => {
  const { config, errors } = normalizeConfig({ enabled: true })
  assert.equal(config.server.port, 443)
  assert.ok(errors.some((error) => error.field === 'server.address'))
  assert.ok(errors.some((error) => error.field === 'server.uuid'))
})

test('flow requires raw/tcp plus reality/tls', () => {
  const { errors } = base({ server: { security: 'none', flow: 'xtls-rprx-vision' } })
  assert.ok(errors.some((error) => error.field === 'server.flow'))
})

test('an unknown flow value is rejected', () => {
  const { errors } = base({ server: { flow: 'xtls-rprx-direct' } })
  assert.ok(errors.some((error) => error.field === 'server.flow'))
})

test('odd-length shortId is rejected', () => {
  const { errors } = base({ server: { shortId: 'abc' } })
  assert.ok(errors.some((error) => error.field === 'server.shortId'))
})

test('a non-base64url REALITY key is rejected', () => {
  const { errors } = base({ server: { password: 'not-a-key' } })
  assert.ok(errors.some((error) => error.field === 'server.password'))
})

test('legacy publicKey alone is accepted and normalized', () => {
  const { config, errors } = base({
    server: {
      password: '',
      publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  })
  assert.deepEqual(errors, [])
  assert.equal(config.server.password, '')
  assert.equal(config.server.publicKey, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
})

test('a non-loopback inbound host is rejected', () => {
  const { errors } = normalizeConfig({ enabled: true, inbound: { host: '0.0.0.0' } })
  assert.ok(errors.some((error) => error.field === 'inbound.host'))
})

test('socks inbound may not reuse the http port', () => {
  const { errors } = base({ root: { inbound: { port: 20808, socks: { enabled: true, port: 20808 } } } })
  assert.ok(errors.some((error) => error.field === 'inbound.socks.port'))
})

test('takeover accepts only auto/force/off', () => {
  const { errors } = base({ root: { takeover: 'always' } })
  assert.ok(errors.some((error) => error.field === 'takeover'))
})

test('numbers given as strings are coerced, invalid numbers are errors', () => {
  const ok = normalizeConfig({ enabled: true, server: { port: '8443' }, inbound: { port: '20999' } })
  assert.equal(ok.config.server.port, 8443)
  assert.equal(ok.config.inbound.port, 20999)

  const bad = normalizeConfig({ enabled: true, server: { port: 'abc' } })
  assert.ok(bad.errors.some((error) => error.field === 'server.port'))
})

test('disabled rows still normalize', () => {
  const { config, errors } = normalizeConfig({ enabled: false })
  assert.equal(config.enabled, false)
  assert.equal(config.server.flow, 'xtls-rprx-vision')
  assert.ok(errors.length > 0) // server fields are empty; supervisor skips them when disabled
})

test('bypass domains accept a comma string and an array', () => {
  const fromString = normalizeConfig({ routing: { bypassDomains: 'a.test, b.test' } })
  assert.deepEqual(fromString.config.routing.bypassDomains, ['a.test', 'b.test'])
  const fromArray = normalizeConfig({ routing: { bypassDomains: ['c.test'] } })
  assert.deepEqual(fromArray.config.routing.bypassDomains, ['c.test'])
})

test('network tcp is normalized to raw', () => {
  const { config } = base({ server: { network: 'tcp' } })
  assert.equal(config.server.network, 'raw')
})
