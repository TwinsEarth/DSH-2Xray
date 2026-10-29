import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { checkForUpdate, compareVersions } from '../lib/update.js'

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('0.2.9', '0.2.8'), 1)
  assert.equal(compareVersions('0.2.8', '0.2.9'), -1)
  assert.equal(compareVersions('0.2.9', '0.2.9'), 0)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1)
})

test('checkForUpdate uses the registry metadata and flags an update', async () => {
  const server = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        version: '9.9.9',
        dist: { tarball: 'https://example.test/pkg.tgz', integrity: 'sha512-abc', shasum: 'abc' },
      }),
    )
  })
  try {
    const { port } = server.address()
    const info = await checkForUpdate({ current: '0.2.9', registry: `http://127.0.0.1:${port}` })
    assert.equal(info.latest, '9.9.9')
    assert.equal(info.available, true)
    assert.equal(info.tarball, 'https://example.test/pkg.tgz')
  } finally {
    server.close()
  }
})

test('checkForUpdate fails closed on a registry error', async () => {
  const server = await serve((request, response) => {
    response.writeHead(503)
    response.end('down')
  })
  try {
    const { port } = server.address()
    const info = await checkForUpdate({ current: '0.2.9', registry: `http://127.0.0.1:${port}` })
    assert.equal(info.available, false)
    assert.match(info.error, /503/)
  } finally {
    server.close()
  }
})
