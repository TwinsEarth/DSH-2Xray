import test from 'node:test'
import assert from 'node:assert/strict'
import { parseShareLink, parseShareLinks, ShareLinkError } from '../lib/share-link.js'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

test('a REALITY share link becomes a node', () => {
  const node = parseShareLink(REALITY)
  assert.equal(node.id, 'Hong Kong')
  assert.equal(node.address, 'hk.example.com')
  assert.equal(node.port, 443)
  assert.equal(node.uuid, '11111111-2222-4333-8444-555555555555')
  assert.equal(node.flow, 'xtls-rprx-vision')
  assert.equal(node.serverName, 'www.example.com')
  assert.equal(node.fingerprint, 'chrome')
  assert.equal(node.password, KEY)
  assert.equal(node.publicKey, KEY)
  assert.equal(node.shortId, 'ab12')
  assert.equal(node.spiderX, '/')
  assert.equal(node.network, 'raw')
  assert.equal(node.security, 'reality')
})

test('defaults fill the fields a short link omits', () => {
  const node = parseShareLink(`vless://uuid-here@example.com?security=reality&sni=s.example.com&pbk=${KEY}`)
  assert.equal(node.port, 443)
  assert.equal(node.fingerprint, 'chrome')
  assert.equal(node.spiderX, '/')
  assert.equal(node.shortId, '')
  assert.equal(node.flow, 'xtls-rprx-vision')
  assert.equal(node.id, 'link-1')
})

test('a v6 literal loses its brackets', () => {
  const node = parseShareLink(`vless://uuid-here@[2001:db8::1]:8443?security=none#v6`)
  assert.equal(node.address, '2001:db8::1')
  assert.equal(node.port, 8443)
})

test('security=none links clear REALITY-only fields', () => {
  const node = parseShareLink(`vless://uuid-here@example.com:8443?security=none&type=tcp#plain`)
  assert.equal(node.security, 'none')
  assert.equal(node.flow, '')
  assert.equal(node.serverName, '')
  assert.equal(node.shortId, '')
  assert.equal(node.password, '')
})

test('non-VLESS schemes are rejected with a named reason', () => {
  assert.throws(
    () => parseShareLink('vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9'),
    (error) => error instanceof ShareLinkError && error.code === 'unsupported-scheme',
  )
  assert.throws(
    () => parseShareLink('not a link'),
    (error) => error instanceof ShareLinkError && error.code === 'invalid-link',
  )
})

test('parseShareLinks keeps the good entries and names bad indexes', () => {
  const { nodes, errors } = parseShareLinks([REALITY, 'vmess://x', `vless://uuid-here@example.com:443?security=none`])
  assert.equal(nodes.length, 2)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].field, 'shareLinks[1]')
})

test('share links feed nodes[], activeNode and the generated config', () => {
  const { config, errors } = normalizeConfig({
    enabled: true,
    shareLinks: [REALITY, `vless://uuid-here@jp.example.com:443?security=none&type=tcp#Japan`],
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.nodes.map((node) => node.id), ['Hong Kong', 'Japan'])
  assert.deepEqual(config.nodes.map((node) => node.tag), ['proxy-Hong_Kong', 'proxy-Japan'])
  assert.equal(config.activeNode, 'proxy-Hong_Kong')

  const built = buildXrayConfig(config)
  assert.deepEqual(built.outbounds.map((outbound) => outbound.tag), ['proxy-Hong_Kong', 'proxy-Japan', 'direct', 'block'])
  assert.equal(built.outbounds[0].streamSettings.realitySettings.serverName, 'www.example.com')
})

test('the singular shareLink field also works', () => {
  const { config, errors } = normalizeConfig({ enabled: true, shareLink: REALITY })
  assert.deepEqual(errors, [])
  assert.equal(config.nodes.length, 1)
  assert.equal(config.nodes[0].id, 'Hong Kong')
})

test('explicit nodes stay first and links are appended', () => {
  const { config } = normalizeConfig({
    enabled: true,
    nodes: [
      {
        id: 'manual',
        address: 'manual.example.com',
        port: 443,
        uuid: '11111111-2222-4333-8444-555555555555',
        serverName: 'www.example.com',
        password: KEY,
        shortId: 'ab12',
      },
    ],
    shareLinks: [REALITY],
  })
  assert.deepEqual(config.nodes.map((node) => node.id), ['manual', 'Hong Kong'])
  assert.equal(config.activeNode, 'proxy-manual')
})
