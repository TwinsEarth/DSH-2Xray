#!/usr/bin/env node
/**
 * Extract the DSH application tree out of an Electron `app.asar` so plain Node
 * can import it.
 *
 * The plugin's compatibility checks have to run against the *real* harness
 * modules (cordis, the loader, dsh-tools, dsh-http-proxy, ...), and a bare
 * `node` process cannot resolve specifiers inside an asar archive — only the
 * Electron runtime can. This tool materialises the tree once into a cache
 * directory; the compat tests then import from there.
 *
 * Usage:
 *   node tools/extract-dsh-app.mjs                       # auto-detect the install
 *   node tools/extract-dsh-app.mjs --asar <path> --out <dir>
 *   node tools/extract-dsh-app.mjs --version             # print detected version
 *
 * Exits non-zero with a readable message when no install is found, so a caller
 * can treat "no DSH here" as a skip rather than a failure.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Heavy, irrelevant to any protocol surface: native binaries and vendored
// desktop payloads. Skipping them keeps the cache around 200 MB instead of 440.
const DEFAULT_SKIP = [
  'dsh/node_modules/@deepseek-ai/libreoffice-kit',
  'dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64',
  'dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64',
  'dsh/node_modules/@deepseek-ai/libreoffice-kit-linux-x64',
  'dsh/node_modules/sherpa-onnx-win-x64',
  'dsh/node_modules/@img/',
  'dsh/node_modules/@koromix/',
  'dsh/node_modules/node-pty/',
]

function parseArgs(argv) {
  const args = { skip: [...DEFAULT_SKIP] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asar') args.asar = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--skip') args.skip.push(argv[++i])
    else if (a === '--version') args.version = true
    else if (a === '--force') args.force = true
    else if (a === '--help') args.help = true
  }
  return args
}

/** Candidate app.asar paths for the desktop install of the current platform. */
export function asarCandidates({ execPath = process.execPath, env = process.env } = {}) {
  if (env.DSH_ASAR) return [env.DSH_ASAR]
  const dir = path.dirname(execPath)
  const candidates = [
    // A CLI layout keeps the harness beside the executable.
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, '..', 'Resources', 'app.asar'),
    path.join(dir, '..', '..', 'Resources', 'app.asar'),
  ]
  // The desktop installer's per-user location. A portable install is elsewhere
  // by definition — name it with --asar or DSH_ASAR.
  if (env.LOCALAPPDATA) {
    const programs = path.join(env.LOCALAPPDATA, 'Programs')
    candidates.push(path.join(programs, 'DeepSeek Harness', 'resources', 'app.asar'))
    try {
      for (const name of fs.readdirSync(programs)) {
        if (/harness|deepseek/i.test(name)) candidates.push(path.join(programs, name, 'resources', 'app.asar'))
      }
    } catch {
      // no Programs directory: nothing to scan
    }
  }
  return candidates
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(8 + headerSize)
  fs.readSync(fd, raw, 0, 8 + headerSize, 0)
  fs.closeSync(fd)
  return { header: JSON.parse(raw.subarray(16, 16 + jsonSize).toString('utf8')), dataOffset: 8 + headerSize }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full, out)
    else out.push({ path: full, size: entry.size ?? 0, offset: entry.offset, unpacked: entry.unpacked === true })
  }
  return out
}

export function readAsarEntry(archive, entry, dataOffset) {
  if (entry.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, ...entry.path.split('/')))
  const fd = fs.openSync(archive, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

/** Version of the bundled harness, without extracting anything. */
export function readAsarHarnessVersion(archive) {
  const { header, dataOffset } = readHeader(archive)
  const entry = walk(header, '', []).find((e) => e.path === 'dsh/node_modules/@deepseek-ai/dsh/package.json')
  if (!entry) return undefined
  return JSON.parse(readAsarEntry(archive, entry, dataOffset).toString('utf8')).version
}

export function findAsar(options) {
  for (const candidate of asarCandidates(options)) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/** Extract the tree; returns a small summary. Idempotent unless `force`. */
export function extract({ archive, out, skip = DEFAULT_SKIP, force = false, log = () => {} } = {}) {
  const versionFile = path.join(out, '.dsh-version')
  const version = readAsarHarnessVersion(archive)
  if (!force && fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8').trim() === version) {
    log(`cache already holds dsh ${version}: ${out}`)
    return { version, files: 0, cached: true, out }
  }
  const { header, dataOffset } = readHeader(archive)
  const entries = walk(header, '', []).filter(
    (e) => e.path.startsWith('dsh/') && !skip.some((prefix) => e.path.startsWith(prefix)),
  )
  let files = 0
  for (const entry of entries) {
    const dest = path.join(out, ...entry.path.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readAsarEntry(archive, entry, dataOffset))
    files++
  }
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(versionFile, `${version}\n`)
  log(`extracted ${files} files of dsh ${version} -> ${out}`)
  return { version, files, cached: false, out }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node tools/extract-dsh-app.mjs [--asar <app.asar>] [--out <dir>] [--force] [--version]')
    return 0
  }
  const archive = args.asar ?? findAsar({})
  if (!archive || !fs.existsSync(archive)) {
    console.error('extract-dsh-app: no app.asar found; pass --asar <path> or set DSH_ASAR')
    return 2
  }
  if (args.version) {
    console.log(readAsarHarnessVersion(archive))
    return 0
  }
  const out = args.out ?? path.join(os.tmpdir(), 'dsh-2xray-compat')
  extract({ archive, out, skip: args.skip, force: args.force, log: (m) => console.log(m) })
  console.log(out)
  return 0
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('extract-dsh-app.mjs')) {
  process.exitCode = main()
}
