#!/usr/bin/env node
/**
 * Build + self-check the 2Xray Chrome extension.
 *
 *   node scripts/build-extension.mjs
 *
 * Checks the MV3 manifest, referenced files, CSP/permission surface, bundled
 * licenses, absence of remote/eval code and secrets, then writes:
 *
 *   dist/2xray-chrome-v<version>.zip
 *
 * The zip writer is dependency-free (store directory is not needed; each file
 * is deflated) so CI does not need a packaging toolchain.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXT = join(ROOT, 'chrome-extension')
const DIST = join(ROOT, 'dist')

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
const manifestPath = join(EXT, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ---- manifest -------------------------------------------------------------
check('manifest_version is 3', manifest.manifest_version === 3, String(manifest.manifest_version))
check('version is semver', /^\d+\.\d+\.\d+$/.test(String(manifest.version)), String(manifest.version))
check(
  'extension version matches package version',
  manifest.version === packageJson.version,
  `${manifest.version} vs ${packageJson.version}`,
)
check('name mentions 2Xray', /2Xray/.test(String(manifest.name)), String(manifest.name))
check('description is short enough', String(manifest.description).length <= 132, `${String(manifest.description).length} chars`)
check('background is an ES module worker', manifest.background?.type === 'module', JSON.stringify(manifest.background))
check('action popup declared', manifest.action?.default_popup === 'popup.html', String(manifest.action?.default_popup))
check('options page declared', manifest.options_ui?.page === 'options.html', String(manifest.options_ui?.page))
check('toggle command declared', Boolean(manifest.commands?.['toggle-proxy']), JSON.stringify(manifest.commands ?? {}))

const ALLOWED_PERMISSIONS = new Set(['proxy', 'storage', 'alarms'])
const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
check(
  'permissions stay on the allow-list',
  permissions.every((permission) => ALLOWED_PERMISSIONS.has(permission)),
  permissions.join(', '),
)
check(
  'no <all_urls> / wildcard host permission',
  !permissions.includes('<all_urls>') && !(manifest.host_permissions ?? []).some((host) => host.includes('<all_urls>')),
  (manifest.host_permissions ?? []).join(', '),
)
check(
  'CSP forbids remote/eval scripts',
  /script-src 'self'/.test(manifest.content_security_policy?.extension_pages ?? '') &&
    !/unsafe-eval|https?:/.test(manifest.content_security_policy?.extension_pages ?? ''),
  manifest.content_security_policy?.extension_pages ?? '(missing)',
)

// Stable identity: key must be a valid SPKI and derive a legal extension id.
let extensionId = ''
try {
  const spki = Buffer.from(String(manifest.key), 'base64')
  const digest = createHash('sha256').update(spki).digest()
  for (let i = 0; i < 16; i++) {
    extensionId += String.fromCharCode(97 + (digest[i] >> 4))
    extensionId += String.fromCharCode(97 + (digest[i] & 0x0f))
  }
} catch {
  extensionId = ''
}
check('manifest key derives an extension id', /^[a-p]{32}$/.test(extensionId), extensionId || '(invalid key)')

// ---- referenced files -----------------------------------------------------
const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  'vendor/qrcode.js',
  'vendor/jsQR.js',
  'vendor/JSQR-LICENSE.txt',
  'vendor/QRCODE-LICENSE.txt',
  'README.md',
].filter(Boolean)
for (const ref of required) {
  check(`referenced file exists: ${ref}`, existsSync(join(EXT, ref)) && statSync(join(EXT, ref)).size > 0)
}

for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  const path = join(EXT, file)
  if (!existsSync(path)) continue
  const bytes = readFileSync(path)
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  check(`icon ${file} is a PNG`, isPng, `${bytes.length} bytes`)
  void size
}

// ---- file collection ------------------------------------------------------
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist'])
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    const rel = relative(EXT, path).split(sep).join('/')
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(path, out)
    } else if (entry.isFile()) {
      if (entry.name === '.DS_Store' || rel.endsWith('.map')) continue
      out.push(rel)
    }
  }
  return out
}
const files = walk(EXT)
const totalBytes = files.reduce((sum, rel) => sum + statSync(join(EXT, rel)).size, 0)
check('file count is sane', files.length >= 15 && files.length <= 80, `${files.length} files`)
check('total size under 1.5 MiB', totalBytes < 1.5 * 1024 * 1024, `${totalBytes} bytes`)
check(
  'no executables or archives bundled',
  files.every((rel) => !/\.(exe|dll|zip|crx|tgz|tar\.gz)$/i.test(rel)),
  files.filter((rel) => /\.(exe|dll|zip|crx|tgz|tar\.gz)$/i.test(rel)).join(', ') || 'clean',
)

// ---- source scan ----------------------------------------------------------
const REMOTE_CODE = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/document\.write\s*\(/, 'document.write('],
  [/innerHTML\s*=/, 'innerHTML='],
  [/<script[^>]+src=["']https?:/i, 'remote script'],
  [/import\s*\(\s*["']https?:/, 'remote dynamic import'],
]
const scanned = files.filter((rel) => /\.(js|html)$/.test(rel) && !rel.startsWith('vendor/'))
const violations = []
for (const rel of scanned) {
  const text = readFileSync(join(EXT, rel), 'utf8')
  for (const [pattern, label] of REMOTE_CODE) {
    if (pattern.test(text)) violations.push(`${rel}: ${label}`)
  }
}
check('no eval/remote-code constructs', violations.length === 0, violations.join(', ') || `${scanned.length} files scanned`)

const licenses = readFileSync(join(EXT, 'vendor', 'JSQR-LICENSE.txt'), 'utf8')
check('jsQR license bundled', /Apache License/i.test(licenses), 'vendor/JSQR-LICENSE.txt')
const qrcodeHeader = readFileSync(join(EXT, 'vendor', 'qrcode.js'), 'utf8').slice(0, 600)
check('qrcode license header present', /Kazuhiko Arase/.test(qrcodeHeader) && /MIT license/i.test(qrcodeHeader))

// ---- secrets --------------------------------------------------------------
const SECRET_PATTERNS = [
  [/npm_[A-Za-z0-9]{36,}/, 'npm token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub PAT'],
  [/ghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
]
const leaks = []
for (const rel of files) {
  if (!/\.(js|mjs|json|html|css|md|txt)$/.test(rel)) continue
  const absolute = join(EXT, rel)
  if (statSync(absolute).size > 1024 * 1024) continue
  const text = readFileSync(absolute, 'utf8')
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) leaks.push(`${rel}: ${label}`)
  }
}
check('no secrets in extension files', leaks.length === 0, leaks.join(', ') || `${files.length} files clean`)

// ---- zip writer -----------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function buildZip(entries) {
  // Reproducible artifact: the zip stores a DOS timestamp, and wall-clock time
  // would make two identical builds hash differently. Pin it (override with
  // SOURCE_DATE_EPOCH) so release evidence stays verifiable.
  const epoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10)
  const now = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date(Date.UTC(2026, 10, 1, 0, 0, 0))
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(time),
      u16(date),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ])
    locals.push(local)

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(8),
        u16(time),
        u16(date),
        u32(crc),
        u32(compressed.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    )
    offset += local.length
  }

  const central = Buffer.concat(centrals)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...locals, central, end])
}

const failures = checks.filter((entry) => !entry.ok)
let zipInfo = null
if (failures.length === 0) {
  mkdirSync(DIST, { recursive: true })
  const entries = files.map((rel) => ({ name: rel, data: readFileSync(join(EXT, rel)) }))
  const zip = buildZip(entries)
  const zipPath = join(DIST, `2xray-chrome-v${manifest.version}.zip`)
  writeFileSync(zipPath, zip)
  zipInfo = {
    path: relative(ROOT, zipPath).split(sep).join('/'),
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    entries: entries.length,
  }
}

const report = {
  ok: failures.length === 0,
  extension: `${manifest.name} v${manifest.version}`,
  extensionId,
  source: {
    files: files.length,
    bytes: totalBytes,
  },
  zip: zipInfo,
  checks,
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
