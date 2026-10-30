#!/usr/bin/env node
/**
 * Release self-check: identity, allow-list, secrets, packaging and doc gates.
 *
 *   node scripts/release-check.mjs
 *
 * Exit 0 = all checks pass. Every check is printed as JSON so the release
 * evidence can quote it verbatim.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

check('name is @twinsearth/dsh-2xray', pkg.name === '@twinsearth/dsh-2xray', pkg.name)
check('version is semver', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
check('publishable', pkg.private !== true, `private=${pkg.private}`)
check('license MIT', pkg.license === 'MIT', String(pkg.license))
check('type module', pkg.type === 'module', String(pkg.type))
check('bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch))

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check('patch row name matches package', patch.includes(pkg.name), 'cordis.patch.yml')
check('patch has an id', /^\s*-\s*id:\s*\S+/m.test(patch), 'cordis.patch.yml')

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
check('README title is DSH-2Xray', readme.startsWith('# DSH-2Xray'), readme.split('\n')[0])
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
check('CHANGELOG has this version', changelog.includes(`## ${pkg.version}`), pkg.version)

// ---- allow-list ----------------------------------------------------------
const allow = readFileSync(join(ROOT, 'release', 'allow-list.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))

function globToRegExp(glob) {
  let out = '^'
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*'
        index++
      } else out += '[^/]*'
    } else if ('\\^$+.()|{}[]'.includes(char)) out += `\\${char}`
    else out += char
  }
  return new RegExp(`${out}$`)
}
const allowPatterns = allow.map(globToRegExp)
const isAllowed = (rel) => allowPatterns.some((pattern) => pattern.test(rel))

const IGNORED = [/^node_modules\//, /^\.git\//, /^\.tmp\//, /^dist\//, /^release\//, /^\.github\//, /^\.gitignore$/]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    const rel = relative(ROOT, absolute).split('\\').join('/')
    if (IGNORED.some((pattern) => pattern.test(rel))) continue
    if (entry.isDirectory()) walk(absolute, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

const files = walk(ROOT)
const outside = files.filter((file) => !isAllowed(file))
check('every packaged file is allow-listed', outside.length === 0, outside.join(', ') || `${files.length} files`)

for (const required of ['index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'lib/supervisor.js', 'lib/control/grpc.js',
  'tools/launch-with-browser-proxy.cmd', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
  check(`required file ${required}`, files.includes(required))
}

// ---- secrets -------------------------------------------------------------
const SECRET_PATTERNS = [
  [/npm_[A-Za-z0-9]{36,}/, 'npm token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub PAT'],
  [/ghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
]
const leaks = []
for (const file of files) {
  if (!/\.(js|mjs|json|md|yml|yaml|txt)$/.test(file)) continue
  const absolute = join(ROOT, file)
  if (statSync(absolute).size > 1024 * 1024) continue
  const text = readFileSync(absolute, 'utf8')
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) leaks.push(`${file}: ${label}`)
  }
}
check('no secrets in packaged files', leaks.length === 0, leaks.join(', ') || 'clean')

const binFiles = files.filter((file) => file.startsWith('bin/'))
// wintun.dll is intentionally bundled for the opt-in TUN mode; xray/v2ray
// executables and archives still must not be committed.
const forbiddenBinaries = binFiles.filter((file) => /(^|\/)(xray|v2ray)(\.exe)?$|\.(exe|zip|tgz|tar\.gz)$/i.test(file))
check(
  'no xray binary committed',
  forbiddenBinaries.length === 0,
  forbiddenBinaries.join(', ') || `bundled: ${binFiles.join(', ') || 'none'}`,
)

const failures = checks.filter((entry) => !entry.ok)
console.log(JSON.stringify({ ok: failures.length === 0, package: `${pkg.name}@${pkg.version}`, files: files.length, checks }, null, 2))
if (failures.length > 0) process.exitCode = 1
