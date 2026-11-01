import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../chrome-extension/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))

test('manifest is MV3 and carries the expected identity', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.match(manifest.name, /2Xray/)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.background.type, 'module')
  assert.equal(manifest.options_ui.page, 'options.html')
  assert.equal(manifest.action.default_popup, 'popup.html')
})

test('the stable key derives the pinned extension id', () => {
  const spki = Buffer.from(manifest.key, 'base64')
  const digest = createHash('sha256').update(spki).digest()
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4))
    id += String.fromCharCode(97 + (digest[i] & 0x0f))
  }
  assert.equal(id, 'jcalgojagadmmjeolgahhmhnmhdkecna')
})

test('declared permissions stay minimal', () => {
  // `videoCapture`/`audioCapture` are packaged-app permissions; Chrome rejects
  // them for extensions ("only allowed for packaged apps"), so the set is exact.
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'proxy', 'storage'])
  assert.equal(manifest.permissions.includes('videoCapture'), false)
  assert.equal(manifest.permissions.includes('<all_urls>'), false)
  assert.equal('optional_host_permissions' in manifest, false)
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    [
      'https://api.ipify.org/*',
      'https://ipinfo.io/*',
      'https://www.google.com/*',
      'https://www.gstatic.com/*',
    ].sort(),
  )
  assert.equal(manifest.content_security_policy.extension_pages.includes('unsafe-eval'), false)
  assert.equal(manifest.content_security_policy.extension_pages.includes('http'), false)
})

test('every referenced file exists', () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    'vendor/qrcode.js',
    'vendor/jsQR.js',
    'vendor/JSQR-LICENSE.txt',
  ]
  for (const ref of refs) {
    const path = join(ROOT, ref)
    assert.equal(existsSync(path), true, ref)
    assert.ok(statSync(path).size > 0, ref)
  }
})

test('popup and options load only local scripts and have no inline script', () => {
  for (const page of ['popup.html', 'options.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8')
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1])
    assert.ok(scriptTags.length > 0, `${page} needs scripts`)
    for (const attrs of scriptTags) {
      const src = /src="([^"]+)"/i.exec(attrs)?.[1]
      assert.ok(src, `${page} has a script tag without src`)
      assert.equal(/^(https?:)?\/\//i.test(src), false, `${page} must not load remote scripts`)
      assert.equal(existsSync(join(ROOT, src)), true, `${page} -> ${src}`)
    }
    const inline = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html)
    assert.equal(inline, false, `${page} must not contain inline script`)
  }
})

test('extension source does not evaluate remote code', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') continue
        walk(path)
      } else if (/\.(js|html)$/.test(entry.name)) files.push(path)
    }
  }
  walk(ROOT)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of [/\beval\s*\(/, /new\s+Function\s*\(/, /document\.write\s*\(/, /innerHTML\s*=/]) {
      assert.equal(pattern.test(text), false, `${file} matches ${pattern}`)
    }
  }
})

test('popup/options scripts reference existing element ids', () => {
  for (const [page, script] of [
    ['popup.html', 'popup.js'],
    ['options.html', 'options.js'],
  ]) {
    const html = readFileSync(join(ROOT, page), 'utf8')
    const js = readFileSync(join(ROOT, script), 'utf8')
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
    const refs = [...js.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1])
    assert.ok(refs.length > 5, `${script} should look up elements`)
    for (const ref of new Set(refs)) {
      assert.equal(ids.has(ref), true, `${script} references #${ref}, missing from ${page}`)
    }
  }
  const options = readFileSync(join(ROOT, 'options.html'), 'utf8')
  for (const mode of ['global', 'whitelist', 'cn-direct']) {
    assert.match(options, new RegExp(`name="mode" value="${mode}"`), `mode radio ${mode}`)
  }
})

test('vendored QR libraries carry their licenses', () => {
  const jsqr = readFileSync(join(ROOT, 'vendor', 'JSQR-LICENSE.txt'), 'utf8')
  assert.match(jsqr, /Apache License/i)
  const qrcode = readFileSync(join(ROOT, 'vendor', 'qrcode.js'), 'utf8')
  assert.match(qrcode, /Kazuhiko Arase/)
  assert.match(qrcode, /MIT license/i)
})

test('generated PAC and config are not committed as extension files', () => {
  for (const path of ['dist', 'config.json', 'xray-config.json']) {
    assert.equal(existsSync(join(ROOT, path)), false, path)
  }
})

test('README documents installation and the process-management boundary', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /加载已解压/)
  assert.match(readme, /Chrome/)
  assert.match(readme, /不能.*(启动|停止)/s)
})
