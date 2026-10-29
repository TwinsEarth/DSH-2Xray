import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'

const base = (overrides = {}) => ({
  enabled: true,
  server: {
    address: 'example.com',
    port: 443,
    uuid: '11111111-2222-4333-8444-555555555555',
    serverName: 'www.example.com',
    password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    shortId: 'ab12',
  },
  ...overrides,
})

test('a remote node port is never mirrored as the local inbound port', () => {
  const { config, warnings } = normalizeConfig(base({ server: { address: 'example.com', port: 556, uuid: '11111111-2222-4333-8444-555555555555' }, inbound: { port: 556 } }))
  assert.equal(config.inbound.port, 20808)
  assert.ok(warnings.some((warning) => warning.includes('privileged') || warning.includes('特权')))
})

test('an inbound port equal to the node port falls back to 20808', () => {
  const { config, warnings } = normalizeConfig(base({ server: { address: 'example.com', port: 8443, uuid: '11111111-2222-4333-8444-555555555555' }, inbound: { port: 8443 } }))
  assert.equal(config.inbound.port, 20808)
  assert.ok(warnings.some((warning) => warning.includes('remote') || warning.includes('远端')))
})
