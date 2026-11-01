/**
 * Integration test for background.js under a mock chrome.* runtime.
 *
 * The extension cannot be launched in Chrome inside this workspace, so the
 * service worker is imported in Node with a in-memory chrome API + fetch stub.
 * This catches the API-shape mistakes that static checks cannot: proxy install
 * callbacks, storage round-trips, message responses, probe parsing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

function createChromeMock() {
  const store = {}
  const proxyState = {
    levelOfControl: 'controllable_by_this_extension',
    value: { mode: 'system' },
  }
  const listeners = {}
  const calls = { badge: [], titles: [] }
  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === undefined || key === null) return { ...store }
          if (typeof key === 'string') return { [key]: store[key] }
          return Object.fromEntries(key.map((name) => [name, store[name]]))
        },
        async set(object) {
          Object.assign(store, JSON.parse(JSON.stringify(object)))
        },
      },
    },
    proxy: {
      settings: {
        get(_details, callback) {
          setTimeout(() => callback({ ...proxyState, value: { ...proxyState.value } }), 0)
        },
        set({ value }, callback) {
          proxyState.value = JSON.parse(JSON.stringify(value))
          proxyState.levelOfControl = 'controlled_by_this_extension'
          setTimeout(callback, 0)
        },
        clear(_details, callback) {
          proxyState.value = { mode: 'system' }
          proxyState.levelOfControl = 'controllable_by_this_extension'
          setTimeout(callback, 0)
        },
      },
      onProxyError: { addListener() {} },
    },
    action: {
      async setBadgeText(details) {
        calls.badge.push(details.text)
      },
      async setBadgeBackgroundColor() {},
      async setTitle(details) {
        calls.titles.push(details.title)
      },
    },
    alarms: {
      async clear() {},
      create() {},
      onAlarm: { addListener() {} },
    },
    commands: {
      onCommand: { addListener() {} },
    },
    runtime: {
      id: 'jcalgojagadmmjeolgahhmhnmhdkecna',
      lastError: undefined,
      getManifest: () => ({ version: '0.1.0' }),
      openOptionsPage() {},
      onMessage: {
        addListener(listener) {
          listeners.message = listener
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
  }
  return { chrome, store, proxyState, listeners, calls }
}

const mock = createChromeMock()
const originalFetch = globalThis.fetch
globalThis.chrome = mock.chrome
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('generate_204')) return new Response(null, { status: 204 })
  if (target.includes('ipinfo.io')) {
    return new Response(JSON.stringify({ ip: '203.0.113.9', country: 'HK', city: 'Hong Kong', org: 'AS64500 Example' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('', { status: 404 })
}

function send(message) {
  return new Promise((resolve, reject) => {
    const listener = mock.listeners.message
    if (!listener) {
      reject(new Error('background did not register onMessage'))
      return
    }
    const keepAlive = listener(message, {}, resolve)
    assert.equal(keepAlive, true, 'async message handler must return true')
  })
}

test('background service worker: enable, probe, routing, import, reset', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch
    delete globalThis.chrome
    delete globalThis.__x2ray
  })

  await import('../chrome-extension/background.js')
  const api = globalThis.__x2ray
  assert.ok(api, 'background should expose __x2ray diagnostics')
  await api.ready

  const initial = await send({ type: 'state' })
  assert.equal(initial.ok, true)
  assert.equal(initial.state.config.enabled, false)
  assert.equal(initial.state.config.proxy.port, 20808)
  assert.equal(initial.state.summary.mode, 'global')
  assert.equal(mock.proxyState.value.mode, 'system', 'disabled extension must clear proxy')

  const enabled = await send({ type: 'set-enabled', enabled: true })
  assert.equal(enabled.ok, true, JSON.stringify(enabled))
  assert.equal(enabled.state.config.enabled, true)
  assert.equal(mock.proxyState.value.mode, 'pac_script')
  assert.match(mock.proxyState.value.pacScript.data, /FindProxyForURL/)
  assert.match(mock.proxyState.value.pacScript.data, /X2_MODE = "global"/)
  assert.equal(enabled.state.runtime.probe.ok, true)
  assert.equal(enabled.state.runtime.probe.latencyMs >= 0, true)
  assert.equal(enabled.state.runtime.probe.exit.ip, '203.0.113.9')
  assert.equal(enabled.state.proxy.levelOfControl, 'controlled_by_this_extension')
  assert.ok(mock.calls.badge.includes('ON'))

  const whitelist = await send({ type: 'save-config', patch: { routing: { mode: 'whitelist' } } })
  assert.equal(whitelist.ok, true, JSON.stringify(whitelist))
  assert.equal(whitelist.state.config.routing.mode, 'whitelist')
  assert.match(mock.proxyState.value.pacScript.data, /X2_MODE = "whitelist"/)
  assert.equal(whitelist.state.runtime.probe.ok, true)

  const bad = await send({ type: 'import-link', link: 'vmess://abc' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].message, /vmess/)

  const imported = await send({ type: 'import-link', link: REALITY })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  assert.equal(imported.state.config.profile.node.address, 'hk.example.com')
  assert.equal(imported.state.config.profile.name, 'Hong Kong')
  assert.match(imported.state.profileLink, /^vless:\/\//)
  assert.equal(mock.store.config.profile.node.uuid, '11111111-2222-4333-8444-555555555555')

  const disabled = await send({ type: 'set-enabled', enabled: false })
  assert.equal(disabled.ok, true)
  assert.equal(disabled.state.config.enabled, false)
  assert.equal(mock.proxyState.value.mode, 'system')

  const reset = await send({ type: 'reset' })
  assert.equal(reset.ok, true)
  assert.equal(reset.state.config.profile.node, null)
  assert.equal(reset.state.config.routing.mode, 'global')
  assert.equal(reset.state.config.proxy.port, 20808)
  assert.equal(reset.state.config.enabled, false)

  const unknown = await send({ type: 'nope' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未知消息/)
})
