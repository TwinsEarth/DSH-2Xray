import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { geodataStatus, updateGeodata } from '../lib/geodata.js'

async function withServer(payload, run) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

test('downloads a geodata file atomically and reports freshness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-geodata-'))
  try {
    const payload = Buffer.alloc(200_000, 0x1f)
    await withServer(payload, async (base) => {
      const result = await updateGeodata({
        dataDir: dir,
        force: true,
        files: [{ file: 'geoip.dat', urls: [`${base}/geoip.dat`] }],
      })
      assert.deepEqual(result.updated.map((entry) => entry.file), ['geoip.dat'])
      assert.equal(existsSync(join(dir, 'geoip.dat')), true)
      assert.equal(statSync(join(dir, 'geoip.dat')).size, payload.length)
      assert.deepEqual(geodataStatus(dir).missing, ['geosite.dat'])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tiny payload is rejected instead of replacing the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-geodata-'))
  try {
    await withServer(Buffer.from('<html>blocked</html>'), async (base) => {
      const result = await updateGeodata({
        dataDir: dir,
        force: true,
        files: [{ file: 'geosite.dat', urls: [`${base}/geosite.dat`] }],
      })
      assert.deepEqual(result.updated, [])
      assert.deepEqual(result.failed, ['geosite.dat'])
      assert.equal(existsSync(join(dir, 'geosite.dat')), false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh files are skipped unless forced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-geodata-'))
  try {
    const payload = Buffer.alloc(200_000, 0x1f)
    await withServer(payload, async (base) => {
      const files = [
        { file: 'geoip.dat', urls: [`${base}/geoip.dat`] },
        { file: 'geosite.dat', urls: [`${base}/geosite.dat`] },
      ]
      await updateGeodata({ dataDir: dir, force: true, files })
      const second = await updateGeodata({ dataDir: dir, files })
      assert.equal(second.skipped, true)
      assert.equal(readFileSync(join(dir, 'geosite.dat')).length, payload.length)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
