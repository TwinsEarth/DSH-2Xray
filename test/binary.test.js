import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { BinaryError, resolveBinary } from '../lib/binary.js'
import { normalizeConfig } from '../lib/config.js'

const packageRoot = join('C:', 'plugins', 'dsh-2xray')
const dataDir = join('C:', 'users', 'me', '.dsh', 'xray-proxy')
const exe = process.platform === 'win32' ? 'xray.exe' : 'xray'
const bundled = join(packageRoot, 'bin', exe)
const managed = join(dataDir, 'bin', exe)

function config(overrides = {}) {
  return normalizeConfig({ enabled: true, ...overrides }).config
}

function only(...paths) {
  return (candidate) => paths.includes(candidate)
}

test('an explicit binary.path wins over everything', async () => {
  const explicit = join('C:', 'tools', exe)
  const found = await resolveBinary({
    config: config({ binary: { path: explicit } }),
    dataDir,
    packageRoot,
    exists: only(explicit, bundled),
  })
  assert.deepEqual(found, { path: explicit, source: 'config' })
})

test('a plugin-shipped bin/xray is preferred over the managed directory', async () => {
  const found = await resolveBinary({
    config: config(),
    dataDir,
    packageRoot,
    exists: only(bundled, managed),
  })
  assert.deepEqual(found, { path: bundled, source: 'bundled' })
})

test('the managed data directory is used when the bundle ships nothing', async () => {
  const found = await resolveBinary({
    config: config(),
    dataDir,
    packageRoot,
    exists: only(managed),
  })
  assert.deepEqual(found, { path: managed, source: 'managed' })
})

test('DSH_XRAY_BIN is used when no explicit path is configured', async () => {
  const previous = process.env.DSH_XRAY_BIN
  process.env.DSH_XRAY_BIN = join('C:', 'portable', exe)
  try {
    const found = await resolveBinary({
      config: config(),
      dataDir,
      packageRoot,
      exists: only(process.env.DSH_XRAY_BIN, bundled),
    })
    assert.equal(found.source, 'env')
  } finally {
    if (previous === undefined) delete process.env.DSH_XRAY_BIN
    else process.env.DSH_XRAY_BIN = previous
  }
})

test('PATH is the last resort and uses resolveExecutable when available', async () => {
  const found = await resolveBinary({
    config: config(),
    dataDir,
    packageRoot,
    exists: () => false,
    launcher: { resolveExecutable: async () => '/usr/local/bin/xray' },
  })
  assert.deepEqual(found, { path: '/usr/local/bin/xray', source: 'path' })
})

test('a missing binary fails with every candidate listed', async () => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  try {
    await assert.rejects(
      () =>
        resolveBinary({
          config: config(),
          dataDir,
          packageRoot,
          exists: () => false,
          launcher: {},
        }),
      (error) => {
        assert.ok(error instanceof BinaryError)
        assert.equal(error.code, 'binary-missing')
        assert.ok(error.candidates.includes(bundled))
        return true
      },
    )
  } finally {
    process.env.PATH = previousPath
  }
})
