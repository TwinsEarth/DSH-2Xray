import test from 'node:test'
import assert from 'node:assert/strict'
import { checkForUpdate, compareVersions } from '../lib/update.js'

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('0.2.9', '0.2.8'), 1)
  assert.equal(compareVersions('0.2.8', '0.2.9'), -1)
  assert.equal(compareVersions('0.2.9', '0.2.9'), 0)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1)
})

test('checkForUpdate reads the registry latest and flags an update', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => ({
    ok: true,
    async json() {
      return { version: '9.9.9', dist: { tarball: 'https://example.test/pkg.tgz', integrity: 'sha512-abc', shasum: 'abc' } }
    },
  })
  try {
    const info = await checkForUpdate({ current: '0.2.9' })
    assert.equal(info.latest, '9.9.9')
    assert.equal(info.available, true)
    assert.equal(info.tarball, 'https://example.test/pkg.tgz')
  } finally {
    globalThis.fetch = original
  }
})

test('checkForUpdate fails closed on a registry error', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  try {
    const info = await checkForUpdate({ current: '0.2.9' })
    assert.equal(info.available, false)
    assert.match(info.error, /503/)
  } finally {
    globalThis.fetch = original
  }
})
