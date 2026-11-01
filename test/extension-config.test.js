import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, applyConfigPatch, normalizeConfig, normalizeDomainList } from '../chrome-extension/lib/config.js'

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

test('the extension defaults normalize without errors', () => {
  const { config, errors, warnings } = normalizeConfig({})
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  assert.equal(config.enabled, false)
  assert.equal(config.proxy.port, 20808)
  assert.equal(config.routing.mode, 'global')
  assert.equal(config.routing.whitelist.length, 7)
  assert.equal(config.profile.node, null)
})

test('the default blacklist accepts URL spelling and dedupes to hosts', () => {
  const { config } = normalizeConfig({})
  assert.equal(config.routing.blacklist.includes('deepseek.com'), true)
  assert.equal(config.routing.blacklist.includes('registry.npmjs.org'), true)
  assert.equal(config.routing.blacklist.filter((entry) => entry === 'registry.npmjs.org').length, 1)
  assert.equal(config.routing.blacklist.some((entry) => entry.startsWith('https://')), false)
  assert.deepEqual(normalizeDomainList(DEFAULT_CONFIG.routing.blacklist), config.routing.blacklist)
})

test('bypass defaults keep bare labels such as lan', () => {
  const { config } = normalizeConfig({})
  assert.equal(config.routing.bypassDomains.includes('lan'), true)
  assert.equal(config.routing.bypassDomains.includes('home.arpa'), true)
})

test('a REALITY share link becomes the active profile', () => {
  const { config, errors } = normalizeConfig({ profile: { shareLink: REALITY } })
  assert.deepEqual(errors, [])
  assert.equal(config.profile.node.address, 'hk.example.com')
  assert.equal(config.profile.node.port, 443)
  assert.equal(config.profile.node.security, 'reality')
  assert.equal(config.profile.name, 'Hong Kong')
  assert.equal(config.profile.shareLink, REALITY)
})

test('a non-VLESS link is reported as a profile error', () => {
  const { config, errors } = normalizeConfig({ profile: { shareLink: 'vmess://abc' } })
  assert.equal(config.profile.node, null)
  assert.equal(errors[0].field, 'profile.shareLink')
  assert.match(errors[0].message, /vmess/)
})

test('unsupported transports are rejected before generating a config', () => {
  const ws = 'vless://11111111-2222-4333-8444-555555555555@example.com:443?security=tls&sni=a.example.com&type=ws#ws'
  const { errors } = normalizeConfig({ profile: { shareLink: ws } })
  assert.equal(errors.some((error) => error.field === 'profile.network'), true)
})

test('REALITY without sni is rejected', () => {
  const link = `vless://11111111-2222-4333-8444-555555555555@example.com:443?security=reality&pbk=${KEY}`
  const { errors } = normalizeConfig({ profile: { shareLink: link } })
  assert.equal(errors.some((error) => error.field === 'profile.serverName'), true)
})

test('enabling without a profile is a warning, not an error', () => {
  const { errors, warnings } = normalizeConfig({ enabled: true })
  assert.deepEqual(errors, [])
  assert.equal(warnings.some((warning) => warning.includes('VLESS')), true)
})

test('invalid proxy, mode and probe values are field errors', () => {
  const { errors } = normalizeConfig({
    proxy: { port: 70000, protocol: 'quic' },
    routing: { mode: 'sometimes' },
    probe: { timeoutMs: 10, intervalMinutes: 0, latencyUrl: 'ftp://x' },
  })
  const fields = errors.map((error) => error.field)
  assert.ok(fields.includes('proxy.port'))
  assert.ok(fields.includes('proxy.protocol'))
  assert.ok(fields.includes('routing.mode'))
  assert.ok(fields.includes('probe.timeoutMs'))
  assert.ok(fields.includes('probe.intervalMinutes'))
  assert.ok(fields.includes('probe.latencyUrl'))
})

test('whitelist entries overlapping the blacklist produce a warning', () => {
  const { warnings } = normalizeConfig({
    enabled: true,
    routing: { mode: 'whitelist', whitelist: ['deepseek.com', 'github.com'] },
  })
  assert.equal(warnings.some((warning) => warning.includes('deepseek.com')), true)
})

test('applyConfigPatch deep-merges and keeps sibling fields', () => {
  const { config } = normalizeConfig({})
  const patched = applyConfigPatch(config, { routing: { mode: 'whitelist' } })
  assert.equal(patched.routing.mode, 'whitelist')
  assert.equal(patched.routing.whitelist.length, 7)
  assert.equal(patched.proxy.port, 20808)
  const next = applyConfigPatch(patched, { profile: { shareLink: REALITY } })
  assert.equal(patched.profile.shareLink, '')
  assert.equal(next.profile.shareLink, REALITY)
})
