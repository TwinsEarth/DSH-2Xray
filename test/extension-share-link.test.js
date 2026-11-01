import test from 'node:test'
import assert from 'node:assert/strict'
import { parseShareLink, parseShareLinks, buildShareLink, ShareLinkError } from '../chrome-extension/lib/share-link.js'

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

test('a REALITY link becomes an extension node', () => {
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

test('short links get the same defaults as the host plugin', () => {
  const node = parseShareLink(`vless://uuid-here@example.com?security=reality&sni=s.example.com&pbk=${KEY}`)
  assert.equal(node.port, 443)
  assert.equal(node.fingerprint, 'chrome')
  assert.equal(node.spiderX, '/')
  assert.equal(node.shortId, '')
  assert.equal(node.flow, 'xtls-rprx-vision')
  assert.equal(node.id, 'link-1')
})

test('a v6 literal loses its brackets', () => {
  const node = parseShareLink('vless://uuid-here@[2001:db8::1]:8443?security=none#v6')
  assert.equal(node.address, '2001:db8::1')
  assert.equal(node.port, 8443)
})

test('security=none clears REALITY-only fields', () => {
  const node = parseShareLink('vless://uuid-here@example.com:8443?security=none&type=tcp#plain')
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

test('parseShareLinks keeps good entries and names bad indexes', () => {
  const { nodes, errors } = parseShareLinks([REALITY, 'vmess://x', 'vless://uuid-here@example.com:443?security=none'])
  assert.equal(nodes.length, 2)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].field, 'shareLinks[1]')
})

test('buildShareLink round-trips the fields the extension consumes', () => {
  const node = parseShareLink(REALITY)
  const link = buildShareLink(node)
  assert.match(link, /^vless:\/\//)
  const again = parseShareLink(link)
  assert.equal(again.address, node.address)
  assert.equal(again.port, node.port)
  assert.equal(again.uuid, node.uuid)
  assert.equal(again.serverName, node.serverName)
  assert.equal(again.password, node.password)
  assert.equal(again.shortId, node.shortId)
  assert.equal(again.flow, node.flow)
  assert.equal(again.security, node.security)
  assert.equal(again.id, node.id)
})

test('buildShareLink wraps IPv6 addresses', () => {
  const node = parseShareLink('vless://uuid-here@[2001:db8::1]:8443?security=none#v6')
  assert.match(buildShareLink(node), /@\[2001:db8::1\]:8443/)
})
