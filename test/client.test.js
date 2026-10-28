import test from 'node:test'
import assert from 'node:assert/strict'

test('the client bundle registers sidebar, main panel and settings entries', async () => {
  let captured
  globalThis.window = { __ModuleLoader__: { load(module) { captured = module } } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }

  assert.equal(captured.id, '@twinsearth/dsh-2xray')
  const createElement = (type, props, ...children) => ({ type, props, children })
  const react = {
    createElement,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const mod = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected module ' + name)
  })

  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(mod.PANEL_ID, 'xray')
  assert.equal(mod.NS, 'xray-proxy')

  const base = []
  const ctx = {
    effect(fn) {
      fn()
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        base.push({ definition, component })
      },
    },
  }
  mod.apply(ctx)

  assert.deepEqual(
    base.map((entry) => entry.definition.name),
    ['sidebar.panellist', 'main'],
  )
  assert.equal(base[0].definition.id, 'xray')
  assert.equal(base[0].definition.order, 1)
  assert.equal(base[0].definition.label(), '2Xray')
  assert.equal(base[0].component().type, 'svg')
  assert.equal(base[1].definition.key, 'xray')

  const settings = []
  const controller = {
    getSnapshot: () => ({ status: 'ready', value: { shareLink: '' }, revision: 0, writable: true }),
    set: async () => true,
    mutate: async () => true,
  }
  const child = {
    effect(fn) {
      fn()
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        settings.push({ definition, component })
      },
    },
    configForms: {
      get: () => controller,
      whileServed(namespaces, register) {
        return register(new Set(namespaces))
      },
    },
  }
  mod.apply({
    effect(fn) {
      fn()
    },
    slots: { inject() {}, register() {} },
    inject(services, callback) {
      assert.deepEqual(services, ['configForms'])
      callback(child)
    },
  })

  assert.deepEqual(
    settings.map((entry) => entry.definition.name),
    ['settings.section', 'plugins.item'],
  )
  // The plugins page looks the form up by the settings namespace, not the panel id.
  assert.equal(settings[0].definition.id, 'xray-proxy')
  assert.equal(settings[1].definition.id, 'xray-proxy')
  assert.equal(settings[1].definition.label(), '2Xray')
})
