import test from 'node:test'
import assert from 'node:assert/strict'
import { assetName, parseDigest, sha256, dataBinDir } from '../tools/install-xray-core.mjs'

test('asset names follow the official release naming per platform', () => {
  assert.equal(assetName('win32', 'x64'), 'Xray-windows-64.zip')
  assert.equal(assetName('darwin', 'arm64'), 'Xray-macos-arm64-v8a.zip')
  assert.equal(assetName('darwin', 'x64'), 'Xray-macos-64.zip')
  assert.equal(assetName('linux', 'x64'), 'Xray-linux-64.zip')
  assert.throws(() => assetName('aix', 'ppc64'), /unsupported/)
})

test('the .dgst parser reads the SHA2-256 line', () => {
  const digest = 'SHA2-256: ' + 'a'.repeat(64) + '\n'
  assert.equal(parseDigest(digest), 'a'.repeat(64))
  assert.throws(() => parseDigest('SHA1: abc'), /SHA2-256/)
})

test('sha256 hashes the downloaded bytes', () => {
  assert.equal(sha256(Buffer.from('abc')).length, 64)
  assert.equal(dataBinDir().endsWith('bin'), true)
})
