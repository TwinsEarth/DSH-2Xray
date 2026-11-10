import test from 'node:test'
import assert from 'node:assert/strict'
import { installTools } from '../lib/tools.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const defineTool = (options) => options

function fakeCtx(registered) {
  return {
    inject(_services, callback) {
      callback({ tools: { register: (tool) => registered.push(tool) } })
    },
  }
}

function makeSupervisor(overrides = {}) {
  const calls = []
  const state = { state: 'ready', enabled: true }
  return {
    calls,
    state,
    snapshot: () => ({ ...state, activeNode: 'proxy-hk-01' }),
    switchNode: async (node) => `proxy-${node}`,
    queryStats: async ({ reset } = {}) => ({ 'proxy-hk-01': { uplink: reset ? 0 : 10, downlink: 20 } }),
    validateConfig: async () => ({ ok: true, detail: 'Configuration OK.', configHash: 'abc' }),
    start: async () => {
      calls.push('start')
      state.state = 'ready'
    },
    pause: async () => {
      calls.push('pause')
      state.state = 'idle'
    },
    reload: async () => {
      calls.push('reload')
      state.state = 'ready'
    },
    ...overrides,
  }
}

test('seven tools are registered when the tool module resolves', async () => {
  const registered = []
  const ok = await installTools({
    ctx: fakeCtx(registered),
    supervisor: makeSupervisor(),
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  assert.equal(ok, true)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    [
      'xray_status',
      'xray_validate_config',
      'xray_switch_node',
      'xray_stats',
      'xray_start',
      'xray_stop',
      'xray_restart',
    ],
  )
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(tool.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
  }
})

test('the tools call the supervisor and return JSON strings', async () => {
  const registered = []
  await installTools({
    ctx: fakeCtx(registered),
    supervisor: makeSupervisor(),
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  const [status, validate, switchNode, stats] = registered

  const statusValue = await status.execute({})
  assert.equal(JSON.parse(statusValue).state, 'ready')

  assert.deepEqual(JSON.parse(await validate.execute({})), {
    ok: true,
    detail: 'Configuration OK.',
    configHash: 'abc',
  })

  assert.equal(await switchNode.execute({ node: 'jp-01' }), JSON.stringify({ activeNode: 'proxy-jp-01' }))

  const statsValue = JSON.parse(await stats.execute({ reset: true }))
  assert.deepEqual(statsValue, { 'proxy-hk-01': { uplink: 0, downlink: 20 } })
})

test('0.9.0 runtime tools drive the supervisor state machine', async () => {
  const registered = []
  await installTools({
    ctx: fakeCtx(registered),
    supervisor: makeSupervisor(),
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  const [, , , , start, stop, restart] = registered

  const started = JSON.parse(await start.execute({}))
  assert.equal(started.ok, true)
  assert.equal(started.status.state, 'ready')

  const stopped = JSON.parse(await stop.execute({}))
  assert.equal(stopped.ok, true)
  assert.equal(stopped.status.state, 'idle')

  const restarted = JSON.parse(await restart.execute({}))
  assert.equal(restarted.ok, true)
})

test('xray_start / xray_restart explain a disabled setting instead of spawning', async () => {
  const registered = []
  const supervisor = makeSupervisor()
  supervisor.state.enabled = false
  await installTools({
    ctx: fakeCtx(registered),
    supervisor,
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  const start = registered.find((tool) => tool.name === 'xray_start')
  const restart = registered.find((tool) => tool.name === 'xray_restart')
  const startResult = JSON.parse(await start.execute({}))
  assert.equal(startResult.ok, false)
  assert.equal(startResult.reason, 'disabled')
  assert.match(startResult.hint, /启用/)
  assert.equal(supervisor.calls.length, 0)
  const restartResult = JSON.parse(await restart.execute({}))
  assert.equal(restartResult.ok, false)
  assert.equal(restartResult.reason, 'disabled')
})

test('a missing tool module only disables the tools', async () => {
  const registered = []
  const ok = await installTools({
    ctx: fakeCtx(registered),
    supervisor: makeSupervisor(),
    logger: silent,
    loadToolsModule: async () => undefined,
  })
  assert.equal(ok, false)
  assert.equal(registered.length, 0)
})

test('a context without inject skips tool registration', async () => {
  const ok = await installTools({
    ctx: {},
    supervisor: makeSupervisor(),
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  assert.equal(ok, false)
})
