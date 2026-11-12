/**
 * Host-half compatibility probes: the plugin's host surface exercised against
 * the harness modules of the *installed* DSH build, not against a fake ctx.
 *
 * Every fake-ctx unit test in `test/` proves what the plugin expects. These
 * probes prove what 0.2.2-rc.2 actually does — plugin lifecycle, the settings
 * schema, the profile patch format, the declared DSH version gate, tool
 * registration, the process-global proxy policy, and the subprocess launch spec.
 *
 * Run: node --test test/compat/host.test.js
 * They skip when no DSH application tree can be located.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveApp, importFile, importPackage, SKIP_MESSAGE } from './harness.mjs'

const app = resolveApp({ log: (message) => console.error(`[compat] ${message}`) })
const skip = app ? false : SKIP_MESSAGE

// The plugin resolves harness packages through `DSH_APP_ANCHOR`; point it at the
// tree under test before any plugin module is imported.
if (app) process.env.DSH_APP_ANCHOR ??= path.join(app.root, 'dsh', 'package.json')

const repoRoot = new URL('../../', import.meta.url)
const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, repoRoot), 'utf8'))
const pluginPkg = readJson('package.json')
const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** Poll a condition instead of sleeping: the plugin registers asynchronously. */
async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

test('the harness under test is the 0.2 line this probe targets', { skip }, (t) => {
  t.diagnostic(`harness @deepseek-ai/dsh ${app.version} at ${app.root}`)
  assert.match(app.version, /^0\.2\./, `compat probes are written for DSH 0.2.x, found ${app.version}`)
})

test('the plugin engine range still admits every runtime the harness starts on', { skip }, async (t) => {
  const semver = await importPackage(app, 'semver')
  const harnessRange = app.packageJson('@deepseek-ai/dsh').engines?.node
  const pluginRange = pluginPkg.engines?.node
  t.diagnostic(`harness node ${harnessRange}; plugin node ${pluginRange}`)
  assert.ok(harnessRange, '@deepseek-ai/dsh declares no engines.node')
  assert.ok(pluginRange, 'the plugin declares no engines.node')
  const harnessFloor = semver.minVersion(harnessRange)
  const pluginFloor = semver.minVersion(pluginRange)
  // A plugin may be stricter than the harness, never looser: a looser range
  // advertises runtimes the harness itself refuses to start on.
  assert.ok(
    semver.lte(pluginFloor, harnessFloor),
    `plugin claims node ${pluginRange} but DSH ${app.version} requires ${harnessRange}`,
  )
})

test('the declared DSH requirement admits the running 0.2.2-rc.2 runtime', { skip }, async (t) => {
  const semver = await importPackage(app, 'semver')
  const range = pluginPkg.engines?.dsh
  t.diagnostic(`plugin engines.dsh ${range ?? '(none)'}; running ${app.version}`)
  assert.equal(typeof range, 'string', 'the plugin must declare engines.dsh so DSH blocks unsupported runtimes')
  // dsh-app-boot checks `engines.dsh` with includePrerelease: true.
  assert.ok(
    semver.satisfies(app.version, range, { includePrerelease: true }),
    `engines.dsh ${range} rejects the running DSH ${app.version}`,
  )
  // The market index publishes the same requirement; a mismatch would let the
  // market advertise an install the runtime then refuses.
  const market = readJson('market/index.json')
  const latest = market.plugins?.[0]?.versions?.[0]
  assert.equal(latest?.engines?.dsh, range, 'market engines.dsh must match package engines.dsh')
})

test('the shipped cordis.patch.yml is a format 0.2.2-rc.2 still applies', { skip }, async (t) => {
  const include = await importPackage(app, '@deepseek-ai/cordis-plugin-include')
  const yaml = await importPackage(app, 'yaml')
  const patches = yaml.parse(fs.readFileSync(new URL('cordis.patch.yml', repoRoot), 'utf8'))
  const entries = include.applyEntryPatches([], patches)
  assert.equal(entries.length, 1, 'the insert row must produce exactly one entry')
  const [entry] = entries
  assert.equal(entry.id, 'xray-proxy')
  assert.equal(entry.name, pluginPkg.name)
  assert.deepEqual(entry.config, { enabled: false })
  t.diagnostic(`applied: ${JSON.stringify(entries)}`)
})

test('the settings schema builds on the harness copy of Schemastery', { skip }, async (t) => {
  // Emulate the installed layout: the plugin sits in a profile whose
  // node_modules carries the harness packages. Copy rather than link — Node
  // resolves a bundle from its realpath, and removing a directory that holds a
  // junction can walk through it and delete the target.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-2xray-schema-'))
  try {
    const pluginDir = path.join(tmp, 'node_modules', '@twinsearth', 'dsh-2xray')
    fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
    fs.copyFileSync(new URL('lib/schema.js', repoRoot), path.join(pluginDir, 'lib', 'schema.js'))
    fs.copyFileSync(new URL('package.json', repoRoot), path.join(pluginDir, 'package.json'))
    // Schemastery 3.19 imports `@deepseek-ai/cosmokit` at runtime, so the
    // synthetic tree needs that transitive dependency too — a profile's package
    // manager installs it, but this copy is hand-made.
    for (const dependency of [
      ['@deepseek-ai', 'schemastery'],
      ['@deepseek-ai', 'cosmokit'],
      ['@standard-schema', 'spec'],
    ]) {
      const source = path.join(app.modules, ...dependency)
      if (!fs.existsSync(source)) continue
      fs.cpSync(source, path.join(tmp, 'node_modules', ...dependency), { recursive: true })
    }

    const { Config } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'schema.js')).href)
    assert.ok(Config, 'lib/schema.js exported no Config against 0.2.2-rc.2 Schemastery')

    // Collect the volatile paths the settings page is allowed to write.
    const volatile = []
    const walk = (schema, prefix) => {
      if (!schema) return
      if (schema.meta?.volatile) volatile.push(prefix)
      for (const [key, child] of Object.entries(schema.dict ?? {})) walk(child, prefix ? `${prefix}.${key}` : key)
    }
    walk(Config, '')
    t.diagnostic(`volatile paths: ${volatile.join(', ')}`)
    assert.ok(volatile.includes('enabled'), 'enabled must stay a volatile top-level field')
    assert.ok(volatile.includes('binary.path'), 'nested volatile fields must survive')
    assert.ok(
      Config({}) && typeof Config({}) === 'object',
      'Config must validate an empty config into defaults',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the plugin activates on a real cordis 4.1 fiber and tears down cleanly', { skip }, async (t) => {
  const { Context } = await importPackage(app, '@deepseek-ai/cordis')
  const host = await import(new URL('index.js', repoRoot))

  const routes = []
  const tools = []
  const released = []
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.push(route)
        return () => released.push(route.path)
      },
    },
  })
  ctx.provide('tools', {
    register(tool) {
      tools.push(tool)
    },
  })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-2xray-apply-'))
  const config = {
    enabled: true,
    takeover: 'off',
    server: {
      address: '127.0.0.1',
      port: 8443,
      uuid: '00000000-0000-4000-8000-000000000000',
      serverName: 'example.com',
      password: 'A'.repeat(43),
      shortId: '',
      fingerprint: 'chrome',
      spiderX: '/',
      network: 'raw',
      security: 'reality',
    },
    inbound: { protocol: 'http', host: '127.0.0.1', port: 20809 },
    binary: { path: path.join(dataDir, 'no-such-xray'), dataDir, autoInstall: false },
  }

  let fiber
  try {
    fiber = await ctx.plugin({ name: host.name, apply: host.apply, Config: host.Config }, config)

    const settled = await waitFor(() => routes.length >= 4 && tools.length >= 4)
    t.diagnostic(`routes: ${routes.map((r) => r.path).join(', ')}`)
    t.diagnostic(`tools: ${tools.map((x) => x.name).join(', ')}`)
    assert.ok(settled, `expected 4 routes and 4 tools; got ${routes.length} routes, ${tools.length} tools`)

    for (const route of routes) {
      assert.match(route.path, /^\/api\/xray\//, 'every route must live under /api/xray/')
      assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${route.path} declares no methods`)
      assert.equal(new Set(route.methods).size, route.methods.length, `${route.path} repeats a method`)
      assert.equal(typeof route.fetch, 'function')
      // 0.2.2-rc.1 defaults an omitted requestBody to 'buffered', so both are
      // legal; the diagnostic records which routes rely on that default.
      assert.ok(
        route.requestBody === undefined || route.requestBody === 'buffered',
        `${route.path} declares requestBody=${String(route.requestBody)}`,
      )
    }
    t.diagnostic(
      `requestBody declared by: ${routes.filter((r) => r.requestBody !== undefined).map((r) => r.path).join(', ') || '(none)'}`,
    )
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'xray_restart',
        'xray_start',
        'xray_stats',
        'xray_status',
        'xray_stop',
        'xray_switch_node',
        'xray_validate_config',
      ],
    )
    // `defineTool` from 0.2.2-rc.2 compiles the parameter spec; a tool that
    // reached `register` carries the compiled JSON Schema, not the raw spec.
    for (const tool of tools) {
      assert.equal(tool.parameters?.type, 'object', `${tool.name} parameters were not compiled`)
      assert.equal(typeof tool.output?.render, 'function')
    }

    // `loader/volatile-update` is the only signal a settings save leaves behind;
    // since 0.9.0 the host applies it in place, and the status route's log ring
    // is where the user sees the change.
    const statusRoute = routes.find((route) => route.path === '/api/xray/status')
    ctx.emit('loader/volatile-update', [['binary', 'path']])
    const response = await statusRoute.fetch(new Request('http://127.0.0.1/api/xray/status?after=0'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.cursor, 'number')
    t.diagnostic(`status keys: ${Object.keys(body.status).join(', ')}`)
    assert.ok(
      body.logs.some((line) => JSON.stringify(line).includes('设置')),
      `no settings-applied line in ${JSON.stringify(body.logs).slice(0, 400)}`,
    )
  } finally {
    if (fiber) await fiber.dispose()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  assert.deepEqual(
    released.sort(),
    ['/api/xray/healthz', '/api/xray/status', '/api/xray/switch', '/api/xray/update'],
    'every connection route must be released when the fiber disposes',
  )
  t.diagnostic(`released: ${released.join(', ')}`)
})

test('the process-global proxy policy is installed through dsh-http-proxy', { skip }, async (t) => {
  const { RouteManager, PROBE_URL } = await import(new URL('lib/route.js', repoRoot))
  const proxy = await importPackage(app, '@deepseek-ai/dsh-http-proxy')
  const manager = new RouteManager({ logger: silent })
  try {
    const snapshot = await manager.install({ proxyUrl: 'http://127.0.0.1:20808', noProxy: 'localhost' })
    t.diagnostic(`snapshot: ${JSON.stringify(snapshot)}`)
    assert.equal(snapshot.installed, true)
    assert.equal(snapshot.mode, 'harness', 'the harness policy path must be the one taken')
    assert.equal(snapshot.proxy, 'http://127.0.0.1:20808')
    assert.equal(snapshot.webFetchCovered, true)
    const route = proxy.proxyRouteFor(new URL(PROBE_URL))
    assert.equal(route.proxied, true, 'the policy must claim the sentinel URL')
    assert.equal(route.proxy, 'http://127.0.0.1:20808')
    assert.equal(manager.snapshot().dispatcherIsOurs, true)
  } finally {
    await manager.restore()
  }
  assert.equal(proxy.proxyRouteFor(new URL(PROBE_URL)).proxied, false, 'restore must drop the policy')
})

test('the tool parameter dialect still compiles and validates', { skip }, async (t) => {
  const tools = await importPackage(app, '@deepseek-ai/dsh-tools')
  const spec = { node: { type: 'string', required: true, description: 'node id' } }
  assert.deepEqual(tools.validateArgs(spec, { node: 'hk-01' }), [])
  const violations = tools.validateArgs(spec, {})
  t.diagnostic(`missing required argument -> ${JSON.stringify(violations)}`)
  assert.ok(violations.length > 0, 'a missing required argument must still be rejected')
  assert.deepEqual(tools.validateArgs({}, {}), [])
})

test('the subprocess launch spec passes 0.2.2-rc.2 validation', { skip }, async (t) => {
  const libDir = path.join(app.modules, '@deepseek-ai', 'dsh-subprocess-local', 'lib')
  const runnerFile = fs.readdirSync(libDir).find((name) => /^runner-launch-.*\.js$/.test(name))
  assert.ok(runnerFile, 'dsh-subprocess-local no longer ships a runner-launch chunk')
  const runner = await import(pathToFileURL(path.join(libDir, runnerFile)).href)
  const validate = runner.E
  assert.equal(typeof validate, 'function', 'the spec validator moved; update this probe')

  // Exactly the shape lib/process.js hands to `ctx.subprocess.spawn`.
  const spec = {
    argv: [process.execPath, '--version'],
    cwd: os.tmpdir(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 5000,
    env: { PATH: process.env.PATH ?? '' },
  }
  validate(spec)
  t.diagnostic('spawn spec accepted')

  assert.throws(() => validate({ ...spec, graceMs: 0 }), /graceMs/)
  assert.throws(() => validate({ ...spec, argv: [] }), /argv/)

  const { default: LocalSubprocessRuntime } = await importPackage(app, '@deepseek-ai/dsh-subprocess-local')
  for (const method of ['spawn', 'resolveExecutable']) {
    assert.equal(
      typeof LocalSubprocessRuntime.prototype[method],
      'function',
      `the subprocess service lost ${method}()`,
    )
  }
})
