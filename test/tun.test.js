import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { buildXrayConfig } from '../lib/xray-config.js'
import { checkTunPrereqs, ensureWintun } from '../lib/tun.js'

function configWithTun() {
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
    tun: { enabled: true },
  }).config
}

test('TUN adds the virtual adapter, DoH resolver and DNS routing', () => {
  const built = buildXrayConfig(configWithTun())
  assert.ok(built.inbounds.some((entry) => entry.protocol === 'tun' && entry.tag === 'tun-in'))
  assert.ok(built.outbounds.some((entry) => entry.tag === 'dns-out' && entry.protocol === 'dns'))
  assert.ok(built.routing.rules.some((rule) => rule.protocol?.includes('dns') && rule.outboundTag === 'dns-out'))
  assert.ok(built.dns.servers.some((server) => server.startsWith('https://')))
  assert.equal(built.dns.queryStrategy, 'UseIP')
})

test('TUN is absent by default', () => {
  const built = buildXrayConfig(
    normalizeConfig({
      enabled: true,
      server: { address: 'example.com', port: 443, uuid: '11111111-2222-4333-8444-555555555555' },
    }).config,
  )
  assert.equal(built.inbounds.some((entry) => entry.protocol === 'tun'), false)
  assert.equal(built.dns, undefined)
})

test('TUN preflight reports missing wintun before spawning xray', () => {
  const result = checkTunPrereqs({
    binaryPath: 'C:\\xray\\xray.exe',
    dataDir: 'C:\\data',
    platform: 'win32',
    isAdmin: true,
    fileExists: () => false,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'tun-wintun-missing')
})

test('TUN preflight requires administrator privileges', () => {
  const result = checkTunPrereqs({
    binaryPath: 'C:\\xray\\xray.exe',
    dataDir: 'C:\\data',
    platform: 'win32',
    isAdmin: false,
    fileExists: () => true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'tun-admin-required')
})

test('TUN preflight passes with wintun and administrator', () => {
  const result = checkTunPrereqs({
    binaryPath: 'C:\\xray\\xray.exe',
    dataDir: 'C:\\data',
    platform: 'win32',
    isAdmin: true,
    fileExists: () => true,
  })
  assert.equal(result.ok, true)
})

test('bundled wintun.dll is copied next to xray once', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wintun-'))
  try {
    const packageBin = join(root, 'package', 'bin')
    const xrayDir = join(root, 'xray')
    mkdirSync(packageBin, { recursive: true })
    mkdirSync(xrayDir, { recursive: true })
    writeFileSync(join(packageBin, 'wintun.dll'), 'fake-dll')
    writeFileSync(join(xrayDir, 'xray.exe'), 'fake-exe')
    const binaryPath = join(xrayDir, 'xray.exe')
    const first = ensureWintun({ binaryPath, packageRoot: join(root, 'package'), platform: 'win32' })
    assert.equal(first.ok, true)
    assert.equal(first.copied, true)
    assert.equal(existsSync(join(xrayDir, 'wintun.dll')), true)
    const second = ensureWintun({ binaryPath, packageRoot: join(root, 'package'), platform: 'win32' })
    assert.equal(second.ok, true)
    assert.equal(second.copied, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
