import test from 'node:test'
import assert from 'node:assert/strict'

test('the client bundle registers a main panel and a sidebar entry', async () => {
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
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(mod.PANEL_ID, 'xray')

  const registrations = []
  const ctx = {
    effect(fn) {
      fn()
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
      },
    },
  }
  mod.apply(ctx)

  assert.deepEqual(
    registrations.map((entry) => entry.definition.name),
    ['main', 'sidebar.panellist'],
  )
  assert.equal(registrations[0].definition.key, 'xray')
  assert.equal(registrations[1].definition.id, 'xray')
  assert.equal(registrations[1].definition.order, 1)
  assert.equal(registrations[1].definition.label(), '2Xray')
  const icon = registrations[1].component()
  assert.equal(icon.type, 'svg')
})
