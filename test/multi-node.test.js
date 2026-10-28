import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'

function node(id, overrides = {}) {
  return {
    id,
    address: `${id}.example.com`,
    port: 443,
    uuid: '11111111-2222-4333-8444-555555555555',
    serverName: 'www.example.com',
    password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    shortId: 'ab12',
    ...overrides,
  }
}

function multi(overrides = {}) {
  return normalizeConfig({
    enabled: true,
    nodes: [node('hk-01'), node('jp-01')],
    control: { enabled: true, port: 10085 },
    ...overrides,
  })
}

test('multiple nodes get distinct outbound tags and default to the first', () => {
  const { config, errors } = multi()
  assert.deepEqual(errors, [])
  assert.deepEqual(config.nodes.map((entry) => entry.tag), ['proxy-hk-01', 'proxy-jp-01'])
  assert.equal(config.activeNode, 'proxy-hk-01')
})

test('activeNode may name an id or a tag', () => {
  assert.equal(multi({ activeNode: 'jp-01' }).config.activeNode, 'proxy-jp-01')
  assert.equal(multi({ activeNode: 'proxy-jp-01' }).config.activeNode, 'proxy-jp-01')
})

test('an unknown activeNode falls back to the first node with a warning', () => {
  const { config, warnings } = multi({ activeNode: 'nope' })
  assert.equal(config.activeNode, 'proxy-hk-01')
  assert.ok(warnings.some((warning) => warning.includes('activeNode')))
})

test('duplicate outbound tags are rejected', () => {
  const { errors } = multi({ nodes: [node('a', { tag: 'same' }), node('b', { tag: 'same' })] })
  assert.ok(errors.some((error) => /tag 重复/.test(error.message)))
})

test('the control port may not collide with an inbound port', () => {
  const { errors } = multi({ control: { enabled: true, port: 20808 } })
  assert.ok(errors.some((error) => error.field === 'control.port'))
})

test('control host must be loopback', () => {
  const { errors } = multi({ control: { enabled: true, host: '0.0.0.0' } })
  assert.ok(errors.some((error) => error.field === 'control.host'))
})

test('multiple nodes without the control plane warn loudly', () => {
  const { warnings } = multi({ control: { enabled: false } })
  assert.ok(warnings.some((warning) => warning.includes('control.enabled')))
})

test('multi-node config preloads every outbound plus one balancer', () => {
  const { config } = multi()
  const built = buildXrayConfig(config)
  assert.deepEqual(
    built.outbounds.map((outbound) => outbound.tag),
    ['proxy-hk-01', 'proxy-jp-01', 'direct', 'block'],
  )
  assert.deepEqual(built.routing.balancers, [
    {
      tag: 'active',
      selector: ['^proxy-hk-01$', '^proxy-jp-01$'],
      strategy: { type: 'random' },
    },
  ])
  const catchAll = built.routing.rules.at(-1)
  assert.equal(catchAll.balancerTag, 'active')
  assert.equal(catchAll.outboundTag, undefined)
})

test('the control plane adds the api inbound, service list, stats and routing rule', () => {
  const { config } = multi()
  const built = buildXrayConfig(config)
  const apiInbound = built.inbounds.find((inbound) => inbound.tag === 'api')
  assert.equal(apiInbound.protocol, 'dokodemo-door')
  assert.equal(apiInbound.listen, '127.0.0.1')
  assert.equal(apiInbound.port, 10085)
  assert.deepEqual(built.api, {
    tag: 'api',
    services: ['HandlerService', 'StatsService', 'RoutingService'],
  })
  assert.deepEqual(built.stats, {})
  assert.equal(built.policy.system.statsOutboundUplink, true)
  assert.deepEqual(built.routing.rules[0], { type: 'field', inboundTag: ['api'], outboundTag: 'api' })
})

test('a single node keeps the legacy config shape (no balancer, api or stats)', () => {
  const { config } = normalizeConfig({
    enabled: true,
    server: node('solo'),
  })
  const built = buildXrayConfig(config)
  assert.equal(built.routing.balancers, undefined)
  assert.equal(built.api, undefined)
  assert.equal(built.stats, undefined)
  assert.equal(built.routing.rules.at(-1).outboundTag, 'proxy')
})
