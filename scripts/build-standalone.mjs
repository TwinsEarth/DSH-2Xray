#!/usr/bin/env node
/**
 * Build the standalone Windows bundle (no DSH required).
 *
 *   node scripts/build-standalone.mjs [--core <dir>]
 *
 * Layout of dist/2xray-standalone-win64-v<version>.zip:
 *   install.cmd / install.ps1 / uninstall.*
 *   core/xray.exe + geoip.dat + geosite.dat
 *   2xray-chrome-v<version>.zip
 *   README.md + THIRD-PARTY-NOTICES.txt
 *
 * The core directory defaults to $HOME/.dsh/xray-proxy/bin (the copy installed
 * by DSH-2Xray); pass --core or XRAY_CORE_DIR to use another official Xray
 * release. The xray binary is redistributed unmodified under MPL-2.0.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DIST = join(ROOT, 'dist')
const STANDALONE = join(ROOT, 'standalone')
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = packageJson.version

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const coreDir = arg('core', process.env.XRAY_CORE_DIR || join(homedir(), '.dsh', 'xray-proxy', 'bin'))
const extensionZip = join(DIST, `2xray-chrome-v${version}.zip`)
const requiredCore = ['xray.exe', 'geoip.dat', 'geosite.dat']

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

check('package version is semver', /^\d+\.\d+\.\d+$/.test(version), version)
for (const file of requiredCore) {
  const path = join(coreDir, file)
  check(`core file exists: ${file}`, existsSync(path), path)
}
const xrayPath = join(coreDir, 'xray.exe')
if (existsSync(xrayPath)) {
  const head = readFileSync(xrayPath).subarray(0, 2).toString('latin1')
  check('xray.exe is a PE binary', head === 'MZ', head)
  check('xray.exe is large enough', statSync(xrayPath).size > 10 * 1024 * 1024, `${statSync(xrayPath).size} B`)
}

// Build the Chrome extension first (also validates it).
if (!process.argv.includes('--skip-extension-build')) {
  let extensionBuildOk = false
  let detail = ''
  try {
    // The sandbox blocks piped child stdio; 'ignore' keeps this working.
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-extension.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    extensionBuildOk = true
  } catch (error) {
    detail = `exit ${error?.status ?? '?'}: ${String(error?.message || error).slice(0, 500)}`
  }
  check('extension build succeeds', extensionBuildOk, detail)
}
check('extension zip exists', existsSync(extensionZip), extensionZip)
if (existsSync(extensionZip)) {
  const stats = statSync(extensionZip)
  check('extension zip is non-empty', stats.size > 100_000, `${stats.size} B`)
}

for (const file of ['install.cmd', 'install.ps1', 'uninstall.cmd', 'uninstall.ps1', 'README.md']) {
  check(`installer file exists: ${file}`, existsSync(join(STANDALONE, 'windows', file)))
}
for (const file of ['install.ps1', 'uninstall.ps1']) {
  const path = join(STANDALONE, 'windows', file)
  if (!existsSync(path)) continue
  const bytes = readFileSync(path)
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  check(`${file} uses UTF-8 BOM (Windows PowerShell 5.1)`, bom, bom ? 'BOM' : 'missing BOM')
}
check('third-party notices exist', existsSync(join(STANDALONE, 'THIRD-PARTY-NOTICES.txt')))

const failures = checks.filter((entry) => !entry.ok)
if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks }, null, 2))
  process.exit(1)
}

const stageName = `2xray-standalone-win64-v${version}`
const stage = join(DIST, stageName)
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'core'), { recursive: true })

for (const file of ['install.cmd', 'install.ps1', 'uninstall.cmd', 'uninstall.ps1', 'README.md']) {
  copyFileSync(join(STANDALONE, 'windows', file), join(stage, file))
}
copyFileSync(join(STANDALONE, 'THIRD-PARTY-NOTICES.txt'), join(stage, 'THIRD-PARTY-NOTICES.txt'))
copyFileSync(extensionZip, join(stage, `2xray-chrome-v${version}.zip`))
for (const file of requiredCore) {
  copyFileSync(join(coreDir, file), join(stage, 'core', file))
}

// ---- zip writer (same format as build-extension) --------------------------
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
  const epoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10)
  const now = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()
  const time = ((now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2)) & 0xffff
  const date = (((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()) & 0xffff
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
      u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), name, compressed,
    ])
    locals.push(local)
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(time), u16(date),
        u32(crc), u32(compressed.length), u32(data.length), u16(name.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
      ]),
    )
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...locals, central, end])
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const files = walk(stage)
const entries = files.map((path) => ({
  name: relative(stage, path).split(sep).join('/'),
  data: readFileSync(path),
}))
const zip = buildZip(entries)
const zipPath = join(DIST, `${stageName}.zip`)
writeFileSync(zipPath, zip)

const report = {
  ok: true,
  product: `2Xray standalone Windows ${version}`,
  core: { source: coreDir, xrayBytes: statSync(xrayPath).size },
  zip: {
    path: relative(ROOT, zipPath).split(sep).join('/'),
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    entries: entries.length,
  },
  stage: relative(ROOT, stage).split(sep).join('/'),
  checks,
}
console.log(JSON.stringify(report, null, 2))
