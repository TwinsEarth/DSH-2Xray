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

const supervisor = {
  snapshot: () => ({ state: 'ready', activeNode: 'proxy-hk-01' }),
  switchNode: async (node) => `proxy-${node}`,
  queryStats: async ({ reset } = {}) => ({ 'proxy-hk-01': { uplink: reset ? 0 : 10, downlink: 20 } }),
  validateConfig: async () => ({ ok: true, detail: 'Configuration OK.', configHash: 'abc' }),
}

test('four tools are registered when the tool module resolves', async () => {
  const registered = []
  const ok = await installTools({
    ctx: fakeCtx(registered),
    supervisor,
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  assert.equal(ok, true)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['xray_status', 'xray_validate_config', 'xray_switch_node', 'xray_stats'],
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
    supervisor,
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

test('a missing tool module only disables the tools', async () => {
  const registered = []
  const ok = await installTools({
    ctx: fakeCtx(registered),
    supervisor,
    logger: silent,
    loadToolsModule: async () => undefined,
  })
  assert.equal(ok, false)
  assert.equal(registered.length, 0)
})

test('a context without inject skips tool registration', async () => {
  const ok = await installTools({
    ctx: {},
    supervisor,
    logger: silent,
    loadToolsModule: async () => ({ module: { defineTool } }),
  })
  assert.equal(ok, false)
})
