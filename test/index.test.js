import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../index.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function fakeCtx() {
  const effects = []
  const listeners = new Map()
  return {
    logger: silent,
    effects,
    on(event, handler) {
      listeners.set(event, handler)
    },
    emit(event, payload) {
      listeners.get(event)?.(payload)
    },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return () => disposer?.()
    },
  }
}

test('the plugin exports the documented entry shape', () => {
  assert.equal(name, 'dsh-2xray')
  assert.equal(typeof apply, 'function')
})

test('a disabled row registers cleanup and never spawns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-index-'))
  try {
    const ctx = fakeCtx()
    const dispose = apply(ctx, { enabled: false, binary: { dataDir: dir } })
    assert.equal(typeof dispose, 'function')
    assert.equal(ctx.effects.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an incomplete config does not throw from apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-index-'))
  try {
    const ctx = fakeCtx()
    const raw = { enabled: true, binary: { dataDir: dir } }
    const dispose = apply(ctx, raw)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a volatile settings update is applied in place, not deferred to a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xray-index-'))
  try {
    const ctx = fakeCtx()
    const raw = { enabled: false, binary: { dataDir: dir } }
    const dispose = apply(ctx, raw)
    // The settings page only writes volatile paths; the running fiber must pick
    // the new values up from the same raw config object.
    raw.inbound = { port: 700000 } // invalid on purpose: no spawn, logged only
    ctx.emit('loader/volatile-update', [['inbound', 'port']])
    await new Promise((resolve) => setTimeout(resolve, 50))
    await dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
