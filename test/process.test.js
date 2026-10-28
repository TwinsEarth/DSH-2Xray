import test from 'node:test'
import assert from 'node:assert/strict'
import { createLauncher, createLazyLauncher } from '../lib/process.js'

const logger = { warn() {} }

test('a context that guards service properties never throws at activation', () => {
  const guarded = { get: () => undefined }
  Object.defineProperty(guarded, 'subprocess', {
    get() {
      throw new Error('cannot get property "subprocess" without inject')
    },
  })
  assert.doesNotThrow(() => createLauncher(guarded, { logger }))
  assert.equal(createLauncher(guarded, { logger }).kind, 'child_process')
})

test('ctx.get is used when it returns the service', () => {
  const service = { spawn() {}, resolveExecutable() {} }
  const ctx = { get: (name) => (name === 'subprocess' ? service : undefined) }
  assert.equal(createLauncher(ctx, { logger }).kind, 'ctx.subprocess')
})

test('a context without ctx.get falls back to child_process', () => {
  assert.equal(createLauncher({}, { logger }).kind, 'child_process')
  assert.equal(createLauncher(undefined, { logger }).kind, 'child_process')
})

test('the lazy launcher resolves at first use, so a later-mounted service is seen', () => {
  let service
  const ctx = { get: () => service }
  const lazy = createLazyLauncher(ctx, { logger })
  service = {
    spawn() {
      return {
        pid: 7,
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: async () => {},
        waitForExit: async () => {},
        collected: {},
      }
    },
    resolveExecutable() {},
  }
  assert.equal(lazy.kind, 'ctx.subprocess')
  const handle = lazy.spawn({ argv: ['x'], cwd: '.', graceMs: 1, env: {} })
  assert.equal(handle.kind, 'ctx.subprocess')
  assert.equal(handle.pid, 7)
})
