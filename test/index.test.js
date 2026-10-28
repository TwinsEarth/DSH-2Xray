import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../index.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function fakeCtx() {
  const effects = []
  return {
    logger: silent,
    effects,
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
    const dispose = apply(ctx, { enabled: true, binary: { dataDir: dir } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
