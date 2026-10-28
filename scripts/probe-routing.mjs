#!/usr/bin/env node
/**
 * Real-runtime routing probe (run it under the DSH runtime, see docs/EVIDENCE.md):
 *
 *   ELECTRON_RUN_AS_NODE=1 "E:\DS\DeepSeek Harness.exe" scripts/probe-routing.mjs
 *
 * It starts a fake local HTTP proxy, installs the plugin's route manager
 * against it, and asserts:
 *   1. globalThis.fetch is proxied (absolute-form request line reaches the proxy,
 *      and a name that cannot resolve directly still gets a response);
 *   2. loopback traffic bypasses the proxy (origin-form request line);
 *   3. restore hands the dispatcher back (the same direct fetch then fails to
 *      resolve, i.e. it is no longer tunnelled).
 *
 * Exits non-zero on the first failed assertion.
 */
import http from 'node:http'
import { RouteManager } from '../lib/route.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
const failures = []
const check = (label, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  if (!condition) failures.push(label)
}

const seen = []
const server = http.createServer((req, res) => {
  seen.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('via-local-proxy')
})
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
console.log(`fake proxy on 127.0.0.1:${port}`)

const route = new RouteManager({ logger })
const snapshot = await route.install({ proxyUrl: `http://127.0.0.1:${port}` })
check('route installed through the harness policy', snapshot.installed && snapshot.mode === 'harness')

try {
  const proxied = await fetch('http://probe.invalid/x')
  const body = await proxied.text()
  check('proxied fetch got the proxy answer', proxied.status === 200 && body === 'via-local-proxy')
  check('proxy saw an absolute-form request line', seen.at(-1) === 'http://probe.invalid/x')

  await fetch(`http://127.0.0.1:${port}/direct`)
  check('loopback traffic bypassed the proxy', seen.at(-1) === '/direct')
} catch (error) {
  check(`proxied fetch threw: ${error.message}`, false)
}

await route.restore()
try {
  await fetch('http://probe.invalid/y')
  check('post-restore fetch is direct again', false)
} catch (error) {
  check('post-restore fetch is direct again (ENOTFOUND)', error.cause?.code === 'ENOTFOUND')
}
server.close()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall routing checks passed')
}
