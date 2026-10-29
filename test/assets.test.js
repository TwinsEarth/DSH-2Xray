import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureXrayAssets } from '../lib/assets.js'

test('geodata next to a v2rayN binary is copied into the managed data dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-xray-assets-'))
  try {
    const bin = join(root, 'v2rayN-windows-64', 'bin')
    const xrayDir = join(bin, 'xray')
    mkdirSync(xrayDir, { recursive: true })
    writeFileSync(join(bin, 'geoip.dat'), 'geoip')
    writeFileSync(join(bin, 'geosite.dat'), 'geosite')
    const dataDir = join(root, 'data')
    const result = ensureXrayAssets({ binaryPath: join(xrayDir, 'xray.exe'), dataDir })
    assert.deepEqual(result.copied.sort(), ['geoip.dat', 'geosite.dat'])
    assert.equal(existsSync(join(dataDir, 'geoip.dat')), true)
    assert.equal(existsSync(join(dataDir, 'geosite.dat')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing geodata is reported rather than silently ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-xray-assets-'))
  try {
    const result = ensureXrayAssets({ binaryPath: join(root, 'xray.exe'), dataDir: join(root, 'data'), discoveryRoots: [] })
    assert.deepEqual(result.copied, [])
    assert.deepEqual(result.missing.sort(), ['geoip.dat', 'geosite.dat'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
