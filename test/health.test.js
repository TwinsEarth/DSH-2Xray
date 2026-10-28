import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tcpConnect, waitForPort, portIsFree, httpProxyProbe, cancellableDelay } from '../lib/health.js'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('tcpConnect sees a live listener and rejects a dead port', async () => {
  const server = http.createServer((_req, res) => res.end())
  const port = await listen(server)
  try {
    assert.equal(await tcpConnect('127.0.0.1', port, 500), true)
    assert.equal(await tcpConnect('127.0.0.1', port + 1, 300), false)
  } finally {
    server.close()
  }
})

test('waitForPort polls until a late listener appears', async () => {
  const port = 21000 + Math.floor(Math.random() * 500)
  const succeeded = waitForPort({ host: '127.0.0.1', port, timeoutMs: 2000, intervalMs: 25 })
  let server
  setTimeout(() => {
    server = http.createServer((_req, res) => res.end())
    server.listen(port, '127.0.0.1')
  }, 150)
  assert.equal(await succeeded, true)
  server.close()
})

test('waitForPort gives up inside the budget', async () => {
  const port = 21500 + Math.floor(Math.random() * 500)
  const started = Date.now()
  assert.equal(await waitForPort({ host: '127.0.0.1', port, timeoutMs: 300, intervalMs: 25 }), false)
  assert.ok(Date.now() - started < 1500)
})

test('portIsFree reflects an occupied port', async () => {
  const server = http.createServer((_req, res) => res.end())
  const port = await listen(server)
  try {
    assert.equal(await portIsFree('127.0.0.1', port), false)
  } finally {
    server.close()
    await new Promise((resolve) => server.once('close', resolve))
  }
  assert.equal(await portIsFree('127.0.0.1', port), true)
})

test('the functional probe needs a 2xx/3xx answer', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url?.includes('ok') ? 204 : 500
    res.end()
  })
  const port = await listen(server)
  try {
    const good = await httpProxyProbe({ host: '127.0.0.1', port, url: 'http://probe.test/ok', timeoutMs: 1000 })
    assert.deepEqual(good, { ok: true, status: 204 })
    const bad = await httpProxyProbe({ host: '127.0.0.1', port, url: 'http://probe.test/fail', timeoutMs: 1000 })
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 500)
  } finally {
    server.close()
  }
})

test('cancellableDelay returns early on abort', async () => {
  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 20)
  await cancellableDelay(5000, controller.signal)
  assert.ok(Date.now() - started < 1000)
})
