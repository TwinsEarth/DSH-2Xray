import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('bundled jsQR decodes a generated QR image without BarcodeDetector', async () => {
  globalThis.window = { __ModuleLoader__: { load() {} } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }
  assert.equal(typeof globalThis.jsQR, 'function', 'client bundle must expose the jsQR fallback')

  const vendor = fs.readFileSync(new URL('../chrome-extension/vendor/qrcode.js', import.meta.url), 'utf8')
  vm.runInThisContext(vendor, { filename: 'qrcode.js' })
  assert.equal(typeof globalThis.QRCode?.encodeText, 'function')

  const text = 'vless://00000000-0000-4000-8000-000000000000@example.com:443?security=tls#jsQR-fallback'
  const qr = globalThis.QRCode.encodeText(text, { errorCorrectLevel: 'M' })
  const modules = qr.getModuleCount()
  const quiet = 4
  const scale = 6
  const size = (modules + quiet * 2) * scale
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 255, 255, 255], i)
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (!qr.isDark(row, column)) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const offset = (((row + quiet) * scale + y) * size + (column + quiet) * scale + x) * 4
          rgba[offset] = 0
          rgba[offset + 1] = 0
          rgba[offset + 2] = 0
          rgba[offset + 3] = 255
        }
      }
    }
  }
  const decoded = globalThis.jsQR(rgba, size, size, { inversionAttempts: 'attemptBoth' })
  assert.equal(decoded?.data, text)
})
