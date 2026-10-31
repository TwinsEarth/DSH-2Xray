import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'

function base(root = {}) {
  return normalizeConfig({
    enabled: true,
    server: {
      address: 'example.com',
      port: 443,
      uuid: '11111111-2222-4333-8444-555555555555',
      serverName: 'www.example.com',
      password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      shortId: 'ab12',
    },
    ...root,
  })
}

function rulesOf(config) {
  return buildXrayConfig(config).routing.rules
}

test('global mode keeps the proxy catch-all and private direct rule', () => {
  const { config, errors } = base()
  assert.deepEqual(errors, [])
  assert.deepEqual(config.routing.whitelist, [
    'github.com',
    'google.com',
    'youtube.com',
    'x.com',
    'facebook.com',
    'api.github.com',
    'raw.githubusercontent.com',
  ])
  assert.deepEqual(config.routing.blacklist, [
    'deepseek.com',
    'chat.deepseek.com',
    'api.deepseek.com',
    'download.deepseek.com',
    'api-docs.deepseek.com',
    'platform.deepseek.com',
    'registry.npmjs.org',
  ])
  const rules = rulesOf(config)
  assert.equal(buildXrayConfig(config).routing.domainStrategy, 'AsIs')
  assert.ok(rules.some((rule) => Array.isArray(rule.ip) && rule.ip.includes('10.0.0.0/8')))
  const catchAll = rules[rules.length - 1]
  assert.equal(catchAll.network, 'tcp,udp')
  assert.equal(catchAll.outboundTag, 'proxy')
})

test('cn-direct adds geosite:cn and geoip:cn direct rules', () => {
  const { config } = base({ routing: { mode: 'cn-direct' } })
  const rules = rulesOf(config)
  assert.equal(buildXrayConfig(config).routing.domainStrategy, 'IPIfNonMatch')
  assert.ok(rules.some((rule) => rule.domain?.includes('geosite:cn')))
  assert.ok(rules.some((rule) => rule.ip?.includes('geoip:cn')))
  assert.equal(rules[rules.length - 1].outboundTag, 'proxy')
})

test('whitelist mode proxies only listed domains and defaults to direct', () => {
  const { config } = base({ routing: { mode: 'whitelist', whitelist: ['github.com', 'youtube.com'] } })
  const rules = rulesOf(config)
  const proxyRule = rules.find((rule) => rule.domain?.includes('domain:github.com'))
  assert.ok(proxyRule)
  assert.equal(proxyRule.outboundTag, 'proxy')
  const catchAll = rules[rules.length - 1]
  assert.equal(catchAll.outboundTag, 'direct')
})

test('blacklisted domains go direct and are added to noProxy', () => {
  const { config } = base({ routing: { blacklist: ['https://api.deepseek.com/anthropic'] } })
  const rules = rulesOf(config)
  assert.equal(rules[0].outboundTag, 'direct')
  assert.ok(rules[0].domain.includes('domain:api.deepseek.com'))
  assert.match(config.noProxy, /(^|,)api\.deepseek\.com(,|$)/)
  assert.equal(config.routing.blacklist.includes('api.deepseek.com'), true)
})

test('whitelist wins over bypassDomains but loses to the blacklist', () => {
  const { config } = base({
    routing: { mode: 'whitelist', whitelist: ['github.com'], blacklist: ['github.com'], bypassDomains: ['github.com'] },
  })
  const rules = rulesOf(config)
  const black = rules.findIndex((rule) => rule.domain?.includes('domain:github.com') && rule.outboundTag === 'direct')
  const white = rules.findIndex((rule) => rule.domain?.includes('domain:github.com') && rule.outboundTag === 'proxy')
  assert.ok(black >= 0)
  assert.equal(white, -1)
})

test('a full registry URL is normalized and deduped against its host form', () => {
  const { config } = base({
    routing: { blacklist: ['registry.npmjs.org', 'https://registry.npmjs.org/'] },
  })
  assert.deepEqual(config.routing.blacklist, ['registry.npmjs.org'])
  assert.match(config.noProxy, /(^|,)registry\.npmjs\.org(,|$)/)
  const rules = rulesOf(config)
  assert.ok(rules[0].domain.includes('domain:registry.npmjs.org'))
})
