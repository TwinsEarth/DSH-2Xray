/**
 * Client-half compatibility probes: the package's `dsh.client` declaration and
 * the browser bundle, checked against the 0.2.2-rc.2 client-module protocol and
 * against a real cordis Context instead of a hand-rolled fake.
 *
 * Run: node --test test/compat/client.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { resolveApp, importPackage, SKIP_MESSAGE } from './harness.mjs'

const app = resolveApp({ log: (message) => console.error(`[compat] ${message}`) })
const skip = app ? false : SKIP_MESSAGE
const repoRoot = new URL('../../', import.meta.url)
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', repoRoot), 'utf8'))

/** Minimal React surface the bundle asks for at materialization time. */
function reactStub() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  const hook = () => undefined
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, hook],
    useEffect: hook,
    useLayoutEffect: hook,
    useRef: () => ({ current: null }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    Fragment: 'fragment',
  }
}

let cachedRegistration
/**
 * Evaluate the bundle the way the page does: one script, one
 * `window.__ModuleLoader__.load` call. A fresh `vm` context keeps this probe
 * independent of any earlier `import()` of the same file in this process —
 * an ESM module evaluates once, so an import-based probe would see zero
 * registrations whenever another test file loaded the bundle first.
 */
function loadBundle() {
  if (cachedRegistration) return cachedRegistration
  const file = new URL('lib/client.js', repoRoot)
  const source = fs.readFileSync(file, 'utf8')
  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  cachedRegistration = registrations[0]
  return cachedRegistration
}

test('the package declares the client protocol 0.2.2-rc.2 reads', { skip }, async (t) => {
  const declaration = pkg.dsh?.client
  t.diagnostic(`dsh.client: ${JSON.stringify(declaration)}`)
  assert.ok(declaration, 'package.json carries no dsh.client declaration')
  // client-modules/lib/index.js:90 — `platform` must be a string.
  assert.equal(typeof declaration.platform, 'string')
  assert.equal(declaration.platform, 'web')
  // client-modules/lib/index.js:91-92 — `inject` and `external` are optional
  // string arrays; anything else is rejected at composition time.
  for (const field of ['inject', 'external']) {
    if (declaration[field] === undefined) continue
    assert.ok(Array.isArray(declaration[field]), `dsh.client.${field} must be an array`)
    for (const name of declaration[field]) assert.equal(typeof name, 'string')
  }
  assert.equal(typeof pkg.dsh?.bundle?.patch, 'string')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')

  // Every injected module must itself be a client module the boot graph can
  // order before this one.
  for (const name of declaration.inject ?? []) {
    const injected = app.packageJson(name)
    assert.equal(
      injected.dsh?.client?.platform,
      'web',
      `${name} is declared as a client dependency but is not a web client module`,
    )
    t.diagnostic(`${name}@${injected.version} platform=${injected.dsh.client.platform}`)
  }
})

test('the bundle registers under the resolved package name', { skip }, async (t) => {
  const registration = await loadBundle()
  assert.equal(registration.id, pkg.name, 'the host keys the browser module by package name')
  assert.equal(typeof registration.factory, 'function')
  t.diagnostic(`registered id: ${registration.id}`)
})

test('the bundle factory produces a cordis plugin on a real Context', { skip }, async (t) => {
  const { Context } = await importPackage(app, '@deepseek-ai/cordis')
  const registration = await loadBundle()
  const exported = registration.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected module request: ${name}`)
  })
  assert.equal(typeof exported.apply, 'function')
  // The bundle was evaluated in another realm, so its array literal carries a
  // different Array prototype; compare the values, not the identity.
  assert.deepEqual([...exported.inject], ['slots'])
  assert.equal(exported.PANEL_ID, 'xray')
  assert.equal(exported.NS, 'xray-proxy')

  const registered = []
  const injectCalls = []
  const ctx = new Context()
  ctx.provide('slots', {
    inject(name, callback) {
      injectCalls.push(name)
      callback()
    },
    register(definition, component) {
      registered.push({ definition, component })
    },
  })
  ctx.provide('configForms', {
    get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, revision: 0, writable: true }), set: async () => true, mutate: async () => true }),
    whileServed(namespaces, register) {
      return register(new Set(namespaces))
    },
  })

  const fiber = await ctx.plugin({ apply: exported.apply, inject: exported.inject })
  try {
    t.diagnostic(`slots injected: ${injectCalls.join(', ')}`)
    t.diagnostic(`slots registered: ${registered.map((entry) => entry.definition.name).join(', ')}`)
    assert.deepEqual(
      registered.map((entry) => entry.definition.name),
      ['sidebar.panellist', 'main', 'settings.section', 'plugins.item'],
    )
    // The Plugins page resolves a form by settings namespace, so both the
    // section and the card must carry it.
    for (const entry of registered.slice(2)) assert.equal(entry.definition.id, 'xray-proxy')
  } finally {
    await fiber.dispose()
  }
})

test('every slot the bundle targets still exists in the shipped UI packages', { skip }, async (t) => {
  const ui = (name) => path.join(app.modules, '@deepseek-ai', name, 'lib', 'client.js')
  const targets = [
    ['sidebar.panellist', ui('dsh-client-ui-sidebar'), 'renderSlot'],
    ['settings.section', ui('dsh-client-ui-settings-general'), 'renderSlot'],
    ['plugins.item', ui('dsh-client-ui-plugin-manager'), 'renderSlot'],
    ['whileServed', ui('dsh-client-ui-settings'), 'configForms'],
  ]
  for (const [needle, file, owner] of targets) {
    const pkgName = path.basename(path.dirname(path.dirname(file)))
    if (!fs.existsSync(file)) {
      t.diagnostic(`skipped ${needle}: ${pkgName} not installed`)
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.includes(needle), `${needle} is not produced by ${pkgName} (${owner})`)
    t.diagnostic(`${needle} -> present in ${pkgName}`)
  }
})
