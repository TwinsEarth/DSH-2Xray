import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { Supervisor } from '../lib/supervisor.js'
import { BinaryError } from '../lib/binary.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function makeConfig(overrides = {}) {
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
    inbound: { host: '127.0.0.1', port: 20808 },
    functionalProbe: { enabled: false },
    lifecycle: {
      startTimeoutMs: 2000,
      stopGraceMs: 500,
      maxRestarts: 2,
      backoffMs: 25,
      backoffMaxMs: 50,
      healthIntervalMs: 0,
      unhealthyThreshold: 3,
      probeTimeoutMs: 300,
    },
    ...overrides,
  }).config
}

class FakeProc {
  constructor(log) {
    this.log = log
    this.stderr = ''
    this.stdout = ''
    this.settled = false
    this.done = new Promise((resolve) => {
      this._resolve = resolve
    })
  }
  stdoutTail() {
    return this.stdout
  }
  stderrTail() {
    return this.stderr
  }
  terminate() {
    this.log.push('terminate')
    this.exit(0)
    return Promise.resolve()
  }
  waitForExit() {
    return this.done.then(() => {})
  }
  exit(code, stderr = '') {
    if (this.settled) return
    this.settled = true
    this.stderr = stderr
    this._resolve({ exitCode: code, signal: null })
  }
}

function makeLauncher({ log = [], testExit = 0, runBehaviour } = {}) {
  const runs = []
  return {
    kind: 'fake',
    runs,
    async resolveExecutable() {
      return '/fake/xray'
    },
    spawn({ argv }) {
      const proc = new FakeProc(log)
      const args = argv.slice(1)
      if (args[0] === 'version') {
        proc.stdout = 'Xray 26.10.21 (go1.24.0)'
        queueMicrotask(() => proc.exit(0))
        return proc
      }
      if (args[0] === 'run' && args.includes('-test')) {
        queueMicrotask(() => proc.exit(testExit, testExit ? 'failed to load config' : 'Configuration OK.'))
        return proc
      }
      runs.push(proc)
      log.push('spawn:run')
      runBehaviour?.(proc, runs.length)
      return proc
    },
  }
}

function makeRoute(log = []) {
  let installed = false
  return {
    installCalls: 0,
    restoreCalls: 0,
    lastProxyUrl: null,
    async install({ proxyUrl } = {}) {
      this.installCalls++
      this.lastProxyUrl = proxyUrl
      installed = true
      log.push('route:install')
      return { installed: true, mode: 'harness', proxy: proxyUrl, webFetchCovered: true, sentinel: 'test' }
    },
    async restore() {
      if (!installed) return
      installed = false
      this.restoreCalls++
      log.push('route:restore')
    },
    snapshot() {
      return { installed, mode: installed ? 'harness' : 'none' }
    },
  }
}

function readyProbes(log = []) {
  return {
    async portIsFree() {
      return true
    },
    waitForPort({ signal }) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false)
        setTimeout(() => {
          log.push('port:ready')
          resolve(true)
        }, 5)
      })
    },
    async httpProxyProbe() {
      return { ok: true, status: 204 }
    },
  }
}

function abortableNeverReady({ signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    signal?.addEventListener('abort', () => resolve(false), { once: true })
  })
}

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeSupervisor({ config = makeConfig(), log = [], ...rest } = {}) {
  const route = makeRoute(log)
  const launcher = rest.launcher ?? makeLauncher({ log })
  const supervisor = new Supervisor({
    config,
    errors: rest.errors ?? [],
    launcher,
    route,
    control: rest.control,
    logger: silent,
    dataDir: rest.dataDir,
    probes: rest.probes ?? readyProbes(log),
    resolveBinaryFn: rest.resolveBinaryFn ?? (async () => ({ path: '/fake/xray', source: 'config' })),
  })
  return { supervisor, route, launcher }
}

test('start resolves binary, spawns, waits for the port, then installs the route', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const { supervisor, route } = makeSupervisor({ log, dataDir: dir })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'ready')
    assert.equal(snap.route.installed, true)
    assert.equal(route.installCalls, 1)
    assert.equal(snap.binary.version, '26.10.21')
    assert.ok(log.indexOf('port:ready') !== -1 && log.indexOf('port:ready') < log.indexOf('route:install'))
    assert.equal(snap.configHash.length, 64)
    await supervisor.stop()
    assert.equal(supervisor.snapshot().state, 'stopped')
  } finally {
    cleanup()
  }
})

test('a missing binary fails with binary-missing and never installs a route', async () => {
  const { dir, cleanup } = workdir()
  try {
    const { supervisor, route } = makeSupervisor({
      dataDir: dir,
      resolveBinaryFn: async () => {
        throw new BinaryError('no xray', 'binary-missing')
      },
    })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'failed')
    assert.equal(snap.reason, 'binary-missing')
    assert.equal(route.installCalls, 0)
  } finally {
    cleanup()
  }
})

test('a config-error exit (23) is terminal and does not restart', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const launcher = makeLauncher({
      log,
      runBehaviour(proc) {
        queueMicrotask(() => proc.exit(23, 'failed to load config files'))
      },
    })
    const { supervisor } = makeSupervisor({ dataDir: dir, launcher, log })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'failed')
    assert.equal(snap.reason, 'config-rejected')
    assert.equal(supervisor.snapshot().restarts, 0)
    assert.equal(launcher.runs.length, 1)
  } finally {
    cleanup()
  }
})

test('a crash after ready restores the route and restarts with backoff', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const launcher = makeLauncher({ log })
    const { supervisor, route } = makeSupervisor({ dataDir: dir, launcher, log })
    await supervisor.start()
    await supervisor.waitFor((s) => s.state === 'ready')
    launcher.runs[0].exit(1, 'boom')
    await supervisor.waitFor((s) => s.state === 'ready' && s.restarts === 1, { timeoutMs: 5000 })
    assert.equal(launcher.runs.length, 2)
    assert.equal(route.restoreCalls, 1)
    assert.equal(route.installCalls, 2)
    await supervisor.stop()
  } finally {
    cleanup()
  }
})

test('a socks primary inbound is handed to the route as socks5://', async () => {  const { dir, cleanup } = workdir()
  try {
    const log = []
    const config = makeConfig({ inbound: { protocol: 'socks', host: '127.0.0.1', port: 20809 } })
    const { supervisor, route } = makeSupervisor({ dataDir: dir, log, config })
    await supervisor.start()
    await supervisor.waitFor((s) => s.state === 'ready')
    assert.equal(route.lastProxyUrl, 'socks5://127.0.0.1:20809')
    await supervisor.stop()
  } finally {
    cleanup()
  }
})

test('stop restores the route before terminating the process', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const { supervisor } = makeSupervisor({ dataDir: dir, log })
    await supervisor.start()
    await supervisor.waitFor((s) => s.state === 'ready')
    log.length = 0
    await supervisor.stop()
    assert.deepEqual(log, ['route:restore', 'terminate'])
  } finally {
    cleanup()
  }
})

test('stop during startup aborts the wait and leaves no live handle', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const { supervisor } = makeSupervisor({
      dataDir: dir,
      log,
      probes: {
        async portIsFree() {
          return true
        },
        waitForPort: abortableNeverReady,
        async httpProxyProbe() {
          return { ok: true }
        },
      },
    })
    const started = supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await supervisor.stop()
    await started
    const snap = supervisor.snapshot()
    assert.equal(snap.state, 'stopped')
    assert.equal(snap.process.alive, false)
    assert.ok(log.includes('terminate'))
  } finally {
    cleanup()
  }
})

test('a busy port is a terminal failure with a readable reason', async () => {
  const { dir, cleanup } = workdir()
  try {
    const { supervisor, route } = makeSupervisor({
      dataDir: dir,
      probes: {
        async portIsFree() {
          return false
        },
        waitForPort: abortableNeverReady,
        async httpProxyProbe() {
          return { ok: true }
        },
      },
    })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'failed')
    assert.equal(snap.reason, 'port-busy')
    assert.equal(route.installCalls, 0)
  } finally {
    cleanup()
  }
})

test('restart is capped by maxRestarts', async () => {
  const { dir, cleanup } = workdir()
  try {
    const log = []
    const launcher = makeLauncher({
      log,
      runBehaviour(proc) {
        // crash every instance shortly after it starts
        setTimeout(() => proc.exit(1, 'boom'), 5)
      },
    })
    const { supervisor } = makeSupervisor({ dataDir: dir, launcher, log })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'failed' && s.reason === 'restart-exhausted', {
      timeoutMs: 5000,
    })
    assert.equal(snap.restarts, 2)
  } finally {
    cleanup()
  }
})

function fakeControl() {
  return {
    calls: [],
    async getBalancerInfo() {
      return { overrideTarget: undefined, principleTargets: [] }
    },
    async overrideBalancerTarget(tag) {
      this.calls.push(tag)
      return tag
    },
    snapshot() {
      return { reachable: true, activeTarget: this.calls.at(-1) ?? null, lastError: null }
    },
  }
}

function multiConfig() {
  const nodes = ['hk-01', 'jp-01'].map((id) => ({
    id,
    address: `${id}.example.com`,
    port: 443,
    uuid: '11111111-2222-4333-8444-555555555555',
    serverName: 'www.example.com',
    password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    shortId: 'ab12',
  }))
  return normalizeConfig({
    enabled: true,
    nodes,
    control: { enabled: true, port: 10085 },
    inbound: { host: '127.0.0.1', port: 20808 },
    functionalProbe: { enabled: false },
    lifecycle: {
      startTimeoutMs: 2000,
      stopGraceMs: 500,
      maxRestarts: 1,
      backoffMs: 25,
      backoffMaxMs: 50,
      healthIntervalMs: 0,
      unhealthyThreshold: 3,
      probeTimeoutMs: 300,
    },
  }).config
}

test('startup pins the balancer to the configured active node', async () => {
  const { dir, cleanup } = workdir()
  try {
    const control = fakeControl()
    const { supervisor } = makeSupervisor({ dataDir: dir, config: multiConfig(), control })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'ready')
    assert.equal(snap.activeNode, 'proxy-hk-01')
    assert.deepEqual(control.calls, ['proxy-hk-01'])
    await supervisor.stop()
  } finally {
    cleanup()
  }
})

test('switchNode pins another outbound without restarting the process', async () => {
  const { dir, cleanup } = workdir()
  try {
    const control = fakeControl()
    const { supervisor, launcher } = makeSupervisor({ dataDir: dir, config: multiConfig(), control })
    await supervisor.start()
    await supervisor.waitFor((s) => s.state === 'ready')
    const runsBefore = launcher.runs.length

    assert.equal(await supervisor.switchNode('jp-01'), 'proxy-jp-01')
    assert.equal(supervisor.snapshot().activeNode, 'proxy-jp-01')
    assert.deepEqual(control.calls, ['proxy-hk-01', 'proxy-jp-01'])
    assert.equal(launcher.runs.length, runsBefore)
    await supervisor.stop()
  } finally {
    cleanup()
  }
})

test('switchNode rejects unknown nodes and a disabled control plane', async () => {
  const { dir, cleanup } = workdir()
  try {
    const control = fakeControl()
    const { supervisor } = makeSupervisor({ dataDir: dir, config: multiConfig(), control })
    await supervisor.start()
    await supervisor.waitFor((s) => s.state === 'ready')
    await assert.rejects(() => supervisor.switchNode('nope'), /未知节点/)
    await supervisor.stop()
  } finally {
    cleanup()
  }

  const disabled = makeSupervisor({ dataDir: undefined, config: makeConfig() }).supervisor
  await assert.rejects(() => disabled.switchNode('proxy'), /control\.enabled=false/)
})

test('a single-node config has no balancer to switch', async () => {
  const config = makeConfig({ control: { enabled: true } })
  const { supervisor } = makeSupervisor({ config, control: fakeControl() })
  await assert.rejects(() => supervisor.switchNode('proxy'), /只有一个节点/)
})

test('validateConfig runs xray -test without touching the running process', async () => {
  const { dir, cleanup } = workdir()
  try {
    const launcher = makeLauncher({ testExit: 0 })
    const { supervisor } = makeSupervisor({ dataDir: dir, launcher })
    const result = await supervisor.validateConfig()
    assert.equal(result.ok, true)
    assert.match(result.detail, /Configuration OK/)
    assert.equal(result.configHash.length, 64)
    assert.equal(supervisor.snapshot().state, 'idle')
    assert.equal(launcher.runs.length, 0)
    const { readdirSync } = await import('node:fs')
    assert.equal(readdirSync(join(dir, 'conf')).some((name) => name.startsWith('validate-')), false)
  } finally {
    cleanup()
  }
})

test('validateConfig reports a rejected config', async () => {
  const { dir, cleanup } = workdir()
  try {
    const launcher = makeLauncher({ testExit: 23 })
    const { supervisor } = makeSupervisor({ dataDir: dir, launcher })
    const result = await supervisor.validateConfig()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'config-rejected')
    assert.match(result.detail, /failed to load config/)
  } finally {
    cleanup()
  }
})

test('validateConfig reports field-level errors without spawning', async () => {
  const { dir, cleanup } = workdir()
  try {
    const launcher = makeLauncher()
    const { supervisor } = makeSupervisor({
      dataDir: dir,
      launcher,
      errors: [{ field: 'server.address', message: '服务端地址不能为空' }],
    })
    const result = await supervisor.validateConfig()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'config-invalid')
    assert.match(result.detail, /server\.address/)
    assert.equal(launcher.runs.length, 0)
  } finally {
    cleanup()
  }
})

test('validateConfig reports a missing binary instead of throwing', async () => {
  const { dir, cleanup } = workdir()
  try {
    const { supervisor } = makeSupervisor({
      dataDir: dir,
      resolveBinaryFn: async () => {
        throw new BinaryError('no xray', 'binary-missing')
      },
    })
    const result = await supervisor.validateConfig()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'binary-missing')
    assert.match(result.detail, /no xray/)
  } finally {
    cleanup()
  }
})

test('a failing functional probe degrades but keeps the process alive', async () => {
  const { dir, cleanup } = workdir()
  try {
    const config = makeConfig({ functionalProbe: { enabled: true, url: 'http://probe.invalid/', timeoutMs: 1000 } })
    const log = []
    const ready = readyProbes(log)
    const { supervisor, route, launcher } = makeSupervisor({
      dataDir: dir,
      config,
      log,
      probes: {
        async portIsFree() {
          return true
        },
        waitForPort: ready.waitForPort,
        async httpProxyProbe() {
          return { ok: false, status: 502 }
        },
      },
    })
    await supervisor.start()
    const snap = await supervisor.waitFor((s) => s.state === 'degraded')
    assert.equal(snap.reason, 'probe-failed')
    assert.equal(snap.process.alive, true)
    assert.equal(route.installCalls, 0)
    assert.equal(launcher.runs.length, 1)
    await supervisor.stop()
  } finally {
    cleanup()
  }
})

