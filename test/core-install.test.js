import test from 'node:test'
import assert from 'node:assert/strict'
import { coreAsset, parseDigest } from '../lib/core-install.js'

test('core asset mapping covers macOS, Linux and Windows', () => {
  assert.equal(coreAsset('darwin', 'arm64'), 'Xray-macos-arm64-v8a.zip')
  assert.equal(coreAsset('darwin', 'x64'), 'Xray-macos-64.zip')
  assert.equal(coreAsset('linux', 'x64'), 'Xray-linux-64.zip')
  assert.equal(coreAsset('linux', 'arm64'), 'Xray-linux-arm64-v8a.zip')
  assert.equal(coreAsset('win32', 'x64'), 'Xray-windows-64.zip')
  assert.equal(coreAsset('aix', 'ppc64'), null)
})

test('digest parser reads the SHA2-256 line', () => {
  const parsed = parseDigest('SHA2-256: ' + 'a'.repeat(64) + '\n')
  assert.equal(parsed, 'a'.repeat(64))
  assert.throws(() => parseDigest('SHA1: nope'), /SHA2-256/)
})
