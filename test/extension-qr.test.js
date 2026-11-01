import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import '../chrome-extension/vendor/qrcode.js'

const jsQrSource = readFileSync(new URL('../chrome-extension/vendor/jsQR.js', import.meta.url), 'utf8')
const sandbox = {}
sandbox.self = sandbox
vm.createContext(sandbox)
vm.runInContext(jsQrSource, sandbox, { filename: 'jsQR.js' })
const jsQR = sandbox.jsQR

const KEY = 'A'.repeat(43)
const REALITY =
  `vless://11111111-2222-4333-8444-555555555555@hk.example.com:443` +
  `?encryption=none&security=reality&sni=www.example.com&fp=chrome` +
  `&pbk=${KEY}&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong`

function rasterize(text, { level = 'M', scale = 4, margin = 4 } = {}) {
  const qr = globalThis.QRCode.encodeText(text, { errorCorrectLevel: level })
  const modules = qr.getModuleCount()
  const width = (modules + margin * 2) * scale
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (col + margin) * scale + dx
          const y = (row + margin) * scale + dy
          const at = (y * width + x) * 4
          data[at] = data[at + 1] = data[at + 2] = 0
        }
      }
    }
  }
  return { data, width, modules, version: (modules - 17) / 4 }
}

test('the vendored jsQR decoder loads in a browser-shaped sandbox', () => {
  assert.equal(typeof jsQR, 'function')
})

for (const level of ['L', 'M', 'Q', 'H']) {
  test(`VLESS link round-trips at EC level ${level}`, () => {
    const { data, width, version } = rasterize(REALITY, { level })
    const decoded = jsQR(data, width, width)
    assert.ok(decoded, 'jsQR must decode the rendered QR')
    assert.equal(decoded.data, REALITY)
    assert.ok(version >= 1 && version <= 40)
  })
}

test('UTF-8 node names survive the byte-mode round trip', () => {
  const link = 'vless://11111111-2222-4333-8444-555555555555@example.com:443?security=none#香港节点·测试'
  const { data, width } = rasterize(link)
  const decoded = jsQR(data, width, width)
  assert.equal(decoded?.data, link)
})

test('a long link selects a higher QR version automatically', () => {
  const long = REALITY + '&padding=' + 'x'.repeat(120) + '#Extra'
  const { data, width, modules, version } = rasterize(long)
  assert.ok(version >= 7, `expected version >= 7, got ${version}`)
  const decoded = jsQR(data, width, width)
  assert.equal(decoded?.data, long)
  assert.equal(modules, version * 4 + 17)
})

test('encoding is deterministic for the same input', () => {
  const first = rasterize(REALITY, { scale: 2 })
  const second = rasterize(REALITY, { scale: 2 })
  assert.equal(first.modules, second.modules)
  assert.deepEqual([...first.data], [...second.data])
})
