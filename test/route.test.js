import test from 'node:test'
import assert from 'node:assert/strict'
import { RouteManager, RouteError } from '../lib/route.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

function makeFakeHarness({ effective = true, preinstalled = false } = {}) {
  let active = preinstalled
  let installCalls = 0
  let disposerCalls = 0
  const dispatcher = { kind: 'policy-dispatcher' }
  const module = {
    proxyRouteFor() {
      return active
        ? { proxied: true, proxy: 'http://127.0.0.1:20808', dispatcher }
        : { proxied: false }
    },
    async installProxyFromEnvironment() {
      installCalls++
      if (effective) active = true
      return async () => {
        disposerCalls++
        active = false
      }
    },
  }
  return {
    module,
    dispatcher,
    stats: () => ({ installCalls, disposerCalls, active }),
  }
}

function makeFakeUndici() {
  let current = { kind: 'previous' }
  const agents = []
  class Agent {
    constructor(options) {
      this.options = options
      agents.push(this)
    }
    close() {
      return Promise.resolve()
    }
    destroy() {}
  }
  class Pool {
    constructor(origin, options) {
      this.origin = origin
      this.options = options
    }
  }
  class ProxyAgent {
    constructor(options) {
      this.options = options
    }
  }
  return {
    module: {
      Agent,
      Pool,
      ProxyAgent,
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (agent) => {
        current = agent
      },
    },
    agents,
    current: () => current,
  }
}

test('harness mode installs the DSH policy and is idempotent', async () => {
  const harness = makeFakeHarness()
  const route = new RouteManager({ logger, loadHarness: async () => ({ module: harness.module }) })

  const first = await route.install({ proxyUrl: 'http://127.0.0.1:20808' })
  assert.equal(first.installed, true)
  assert.equal(first.mode, 'harness')
  assert.equal(first.webFetchCovered, true)
  assert.equal(harness.stats().installCalls, 1)

  const second = await route.install({ proxyUrl: 'http://127.0.0.1:20808' })
  assert.equal(second.reason, 'already-installed')
  assert.equal(harness.stats().installCalls, 1)

  await route.restore()
  assert.equal(harness.stats().active, false)
  assert.equal(harness.stats().disposerCalls, 1)
  assert.equal(route.snapshot().installed, false)
})

test('an existing launcher policy is respected under takeover=auto', async () => {
  const harness = makeFakeHarness({ preinstalled: true })
  const route = new RouteManager({ logger, loadHarness: async () => ({ module: harness.module }) })
  const result = await route.install({ proxyUrl: 'http://127.0.0.1:20808', force: false })
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'external-proxy-active')
  assert.equal(harness.stats().installCalls, 0)
})

test('takeover=force overrides an existing policy', async () => {
  const harness = makeFakeHarness({ preinstalled: true })
  const route = new RouteManager({ logger, loadHarness: async () => ({ module: harness.module }) })
  const result = await route.install({ proxyUrl: 'http://127.0.0.1:20808', force: true })
  assert.equal(result.installed, true)
  assert.equal(harness.stats().installCalls, 1)
  await route.restore()
})

test('a policy that does not take effect is rejected and rolled back', async () => {
  const harness = makeFakeHarness({ effective: false })
  const route = new RouteManager({ logger, loadHarness: async () => ({ module: harness.module }) })
  await assert.rejects(
    () => route.install({ proxyUrl: 'http://127.0.0.1:20808' }),
    (error) => error instanceof RouteError && error.code === 'route-instance-mismatch',
  )
  assert.equal(harness.stats().disposerCalls, 1)
  assert.equal(route.snapshot().installed, false)
})

test('builtin mode installs its own dispatcher when the harness package is missing', async () => {
  const undici = makeFakeUndici()
  const route = new RouteManager({
    logger,
    loadHarness: async () => undefined,
    loadUndici: async () => undici.module,
  })
  const snapshot = await route.install({ proxyUrl: 'http://127.0.0.1:20808', noProxy: 'corp.test' })
  assert.equal(snapshot.mode, 'builtin')
  assert.equal(snapshot.webFetchCovered, false)
  assert.equal(undici.current(), undici.agents[0])

  const factory = undici.agents[0].options.factory
  assert.ok(factory(new URL('https://api.deepseek.com'), {}) instanceof undici.module.ProxyAgent)
  assert.ok(factory(new URL('http://127.0.0.1:53343'), {}) instanceof undici.module.Pool)
  assert.ok(factory(new URL('https://git.corp.test'), {}) instanceof undici.module.Pool)

  await route.restore()
  assert.equal(undici.current().kind, 'previous')
})

test('a socks inbound always takes the builtin path', async () => {
  let harnessLoaded = false
  const undici = makeFakeUndici()
  const route = new RouteManager({
    logger,
    loadHarness: async () => {
      harnessLoaded = true
      return { module: makeFakeHarness().module }
    },
    loadUndici: async () => undici.module,
  })
  const snapshot = await route.install({ proxyUrl: 'socks5://127.0.0.1:20809' })
  assert.equal(harnessLoaded, false)
  assert.equal(snapshot.mode, 'builtin')
  await route.restore()
})

test('the policy verification host is reserved and cannot be in noProxy', async () => {
  const { PROBE_URL } = await import('../lib/route.js')
  const url = new URL(PROBE_URL)
  assert.equal(url.hostname, 'dsh-2xray-verify.invalid')
  assert.equal(url.hostname.endsWith('.invalid'), true)
  assert.notEqual(url.hostname, 'api.deepseek.com')
})
