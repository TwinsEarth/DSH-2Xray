import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, reloadPlan, runtimeSignature } from '../lib/config.js'
import { Supervisor } from '../lib/supervisor.js'
import { Monitor } from '../lib/monitor.js'
import { describePortOwner } from '../lib/health.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function cfg(overrides = {}) {
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
      stopGraceMs: 200,
      maxRestarts: 2,
      backoffMs: 20,
      backoffMaxMs: 40,
      healthIntervalMs: 0,
      unhealthyThreshold: 3,
      probeTimeoutMs: 200,
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

function makeLauncher() {
  const runs = []
  return {
    runs,
    async resolveExecutable() {
      return '/fake/xray'
    },
    spawn({ argv }) {
      const proc = new FakeProc([])
      const args = argv.slice(1)
      if (args[0] === 'version') {
        proc.stdout = 'Xray 26.10.21 (go1.24.0)'
        queueMicrotask(() => proc.exit(0))
        return proc
      }
      if (args[0] === 'run' && args.includes('-test')) {
        queueMicrotask(() => proc.exit(0, 'Configuration OK.'))
        return proc
      }
      runs.push(proc)
      proc.pid = 4000 + runs.length
      return proc
    },
  }
}

function makeRoute() {
  let installed = false
  return {
    installCalls: 0,
    restoreCalls: 0,
    lastProxyUrl: null,
    async install({ proxyUrl } = {}) {
      this.installCalls++
      this.lastProxyUrl = proxyUrl
      installed = true
      return { installed: true, mode: 'harness', proxy: proxyUrl, webFetchCovered: true, sentinel: 'test' }
    },
    async restore() {
      if (!installed) return
      installed = false
      this.restoreCalls++
    },
    snapshot() {
      return { installed, mode: installed ? 'harness' : 'none' }
    },
  }
}

function readyProbes(extra = {}) {
  return {
    async portIsFree() {
      return true
    },
    waitForPort() {
      return Promise.resolve(true)
    },
    async httpProxyProbe() {
      return { ok: true, status: 204 }
    },
    async describePortOwner() {
      return null
    },
    ...extra,
  }
}

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-reload-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeSupervisor({ config = cfg(), probes, dataDir } = {}) {
  return new Supervisor({
    config,
    launcher: makeLauncher(),
    route: makeRoute(),
    logger: silent,
    dataDir,
    probes: probes ?? readyProbes(),
    resolveBinaryFn: async () => ({ path: '/fake/xray', source: 'config' }),
  })
}

test('reloadPlan maps volatile settings changes to supervisor actions', () => {
  const disabled = cfg({ enabled: false })
  const enabled = cfg({ enabled: true })
  const movedPort = cfg({ inbound: { host: '127.0.0.1', port: 20809 } })
  const quietChange = cfg({ updates: { auto: true }, geodata: { autoUpdate: false } })

  assert.deepEqual(reloadPlan(disabled, enabled), { action: 'start', reason: 'enabled' })
  assert.deepEqual(reloadPlan(enabled, disabled), { action: 'stop', reason: 'disabled' })
  assert.deepEqual(reloadPlan(enabled, movedPort), { action: 'restart', reason: 'config-changed' })
  assert.deepEqual(reloadPlan(enabled, quietChange), { action: 'none', reason: 'unchanged' })
  assert.deepEqual(reloadPlan(disabled, cfg({ enabled: false, updates: { auto: true } })), {
    action: 'update',
    reason: 'disabled-config',
  })
})

test('runtimeSignature ignores fields that never require a restart', () => {
  const base = cfg()
  assert.equal(runtimeSignature(base), runtimeSignature(cfg({ updates: { auto: true }, geodata: { autoUpdate: false } })))
  assert.notEqual(runtimeSignature(base), runtimeSignature(cfg({ inbound: { host: '127.0.0.1', port: 20809 } })))
})

test('monitor.configure repoints probes and clears cached measurements', () => {
  const monitor = new Monitor({ host: '127.0.0.1', port: 20808, logger: silent })
  monitor.maybeRefresh({ ready: false })
  assert.equal(monitor.snapshot().latency.state, 'skipped')
  monitor.configure({ host: '127.0.0.1', port: 20809, latencyUrl: 'http://probe.test/204' })
  const snap = monitor.snapshot()
  assert.equal(snap.latency.state, 'idle')
  assert.equal(snap.egress.state, 'idle')
})

test('describePortOwner parses netstat/tasklist output', { skip: process.platform !== 'win32' }, () => {
  const outputs = {
    netstat: '  TCP    127.0.0.1:20808        0.0.0.0:0              LISTENING       12648\r\n',
    tasklist: '"xray.exe","12648","Console","1","37,369,344 K"\r\n',
  }
  const runner = (command) => ({ stdout: outputs[command] ?? '' })
  assert.deepEqual(describePortOwner({ port: 20808, host: '127.0.0.1', runner }), {
    pid: 12648,
    name: 'xray.exe',
    host: '127.0.0.1',
    port: 20808,
  })
  assert.equal(describePortOwner({ port: 20811, runner }), null)
})

test('applyConfig starts, hot-restarts and stops the child without disposing the supervisor', async () => {
  const { dir, cleanup } = workdir()
  try {
    const launcher = makeLauncher()
    const supervisor = new Supervisor({
      config: cfg({ enabled: false }),
      launcher,
      route: makeRoute(),
      logger: silent,
      dataDir: dir,
      probes: readyProbes(),
      resolveBinaryFn: async () => ({ path: '/fake/xray', source: 'config' }),
    })

    assert.equal(supervisor.snapshot().state, 'idle')
    assert.equal(await supervisor.applyConfig(cfg({ enabled: true }), { dataDir: dir }), 'start')
    await supervisor.waitFor((snap) => snap.state === 'ready')
    assert.equal(launcher.runs.length, 1)
    assert.equal(supervisor.snapshot().enabled, true)

    const moved = cfg({ inbound: { host: '127.0.0.1', port: 20809 } })
    assert.equal(await supervisor.applyConfig(moved, { dataDir: dir }), 'restart')
    await supervisor.waitFor((snap) => snap.state === 'ready' && snap.port === 20809)
    assert.equal(launcher.runs.length, 2)

    assert.equal(await supervisor.applyConfig(cfg({ enabled: false }), { dataDir: dir }), 'stop')
    assert.equal(supervisor.snapshot().state, 'idle')
    assert.equal(supervisor.snapshot().reason, 'disabled')

    // A stopped-by-settings supervisor must be reusable: this is the bug that
    // made the 启用 switch "do nothing" until a DSH restart.
    assert.equal(await supervisor.applyConfig(cfg({ enabled: true }), { dataDir: dir }), 'start')
    await supervisor.waitFor((snap) => snap.state === 'ready')
    assert.equal(launcher.runs.length, 3)

    await supervisor.stop()
    assert.equal(supervisor.snapshot().state, 'stopped')
  } finally {
    cleanup()
  }
})

test('a busy port reports the owning process in the failure detail', async () => {
  const { dir, cleanup } = workdir()
  try {
    const supervisor = makeSupervisor({
      dataDir: dir,
      probes: readyProbes({
        portIsFree: async () => false,
        describePortOwner: async () => ({ pid: 12648, name: 'xray.exe' }),
      }),
    })
    await supervisor.start()
    const snap = await supervisor.waitFor((state) => state.state === 'failed')
    assert.equal(snap.reason, 'port-busy')
    assert.match(snap.detail, /12648/)
    assert.match(snap.detail, /xray\.exe/)
    assert.match(snap.detail, /inbound\.port/)
  } finally {
    cleanup()
  }
})
