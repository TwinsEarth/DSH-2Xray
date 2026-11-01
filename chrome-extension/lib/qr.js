/**
 * Canvas rendering for share-link QR codes.
 *
 * The encoder itself is the vendored MIT `qrcode.js` (classic Kazuhiko Arase
 * implementation), loaded by popup.html / options.html before this module.
 * Kept DOM-only so Node tests can test the encoder via vendor/qrcode.js.
 */

export function drawQr(canvas, text, options = {}) {
  const QRCode = globalThis.QRCode
  if (!QRCode) throw new Error('二维码编码库未加载（vendor/qrcode.js）')
  if (!text) throw new Error('没有可编码的链接')
  const size = options.size ?? 220
  const quietZone = options.quietZone ?? 4
  const errorCorrectLevel = options.errorCorrectLevel ?? 'M'
  const qr = QRCode.encodeText(text, { errorCorrectLevel })
  const modules = qr.getModuleCount()
  const total = modules + quietZone * 2
  const scale = Math.max(1, Math.floor(size / total))
  const pixels = total * scale
  canvas.width = pixels
  canvas.height = pixels
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持 canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pixels, pixels)
  ctx.fillStyle = '#0f172a'
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue
      ctx.fillRect((col + quietZone) * scale, (row + quietZone) * scale, scale, scale)
    }
  }
  return { modules, version: (modules - 17) / 4, pixels }
}
