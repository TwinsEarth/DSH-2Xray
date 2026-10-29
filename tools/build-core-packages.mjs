#!/usr/bin/env node
/**
 * Turn official Xray-core zips into per-platform npm packages.
 *
 * npm installs only the package whose `os`/`cpu` matches, so the main package
 * can depend on all of them without downloading five cores. CI can run this on
 * each runner (where GitHub release downloads work); locally it also accepts a
 * directory of already-downloaded zips.
 *
 * Usage:
 *   node tools/build-core-packages.mjs --zips ./vendor/zips --out ./dist-core --version 0.2.9
 *
 * Expected zip names (official release assets):
 *   Xray-windows-64.zip, Xray-windows-arm64-v8a.zip
 *   Xray-macos-64.zip, Xray-macos-arm64-v8a.zip
 *   Xray-linux-64.zip, Xray-linux-arm64-v8a.zip
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const TARGETS = [
  { zip: 'Xray-windows-64.zip', pkg: 'win32-x64', os: 'win32', cpu: 'x64', exe: 'xray.exe' },
  { zip: 'Xray-windows-arm64-v8a.zip', pkg: 'win32-arm64', os: 'win32', cpu: 'arm64', exe: 'xray.exe' },
  { zip: 'Xray-macos-64.zip', pkg: 'darwin-x64', os: 'darwin', cpu: 'x64', exe: 'xray' },
  { zip: 'Xray-macos-arm64-v8a.zip', pkg: 'darwin-arm64', os: 'darwin', cpu: 'arm64', exe: 'xray' },
  { zip: 'Xray-linux-64.zip', pkg: 'linux-x64', os: 'linux', cpu: 'x64', exe: 'xray' },
  { zip: 'Xray-linux-arm64-v8a.zip', pkg: 'linux-arm64', os: 'linux', cpu: 'arm64', exe: 'xray' },
]

function args() {
  const parsed = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index].replace(/^--/, '')
    parsed[key] = process.argv[index + 1]
  }
  return {
    zips: parsed.zips ?? './vendor/zips',
    out: parsed.out ?? './dist-core',
    version: parsed.version ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  }
}

function extract(zip, destination) {
  const attempts =
    process.platform === 'win32'
      ? [['tar', ['-xf', zip, '-C', destination]], ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destination}' -Force`]]]
      : [['unzip', ['-o', zip, '-d', destination]], ['tar', ['-xf', zip, '-C', destination]]]
  for (const [command, argv] of attempts) {
    if (spawnSync(command, argv, { stdio: 'ignore' }).status === 0) return
  }
  throw new Error(`could not extract ${zip}`)
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const nested = findBinary(full, name)
      if (nested) return nested
    }
  }
  return undefined
}

const options = args()
mkdirSync(options.out, { recursive: true })
const built = []
for (const target of TARGETS) {
  const zip = join(options.zips, target.zip)
  if (!existsSync(zip)) {
    console.log(`skip ${target.pkg}: ${target.zip} not present`)
    continue
  }
  const workspace = mkdtempSync(join(tmpdir(), `dsh-core-${target.pkg}-`))
  try {
    extract(zip, workspace)
    const binary = findBinary(workspace, target.exe)
    if (!binary) throw new Error(`${target.exe} not found in ${target.zip}`)
    const packageName = `@twinsearth/dsh-2xray-core-${target.pkg}`
    const dir = join(options.out, `dsh-2xray-core-${target.pkg}`)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    copyFileSync(binary, join(dir, 'bin', target.exe))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          version: options.version,
          description: `Xray-core binary for ${target.pkg} (DSH-2Xray optional dependency)`,
          license: 'MPL-2.0',
          os: [target.os],
          cpu: [target.cpu],
          files: ['bin'],
        },
        null,
        2,
      ) + '\n',
    )
    built.push({ name: packageName, dir, size: statSync(join(dir, 'bin', target.exe)).size })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

for (const entry of built) {
  console.log(`built ${entry.name} (${Math.round(entry.size / 1048576)} MB) -> ${entry.dir}`)
}
if (built.length === 0) {
  console.log(`no zips found in ${options.zips}`)
  process.exitCode = 1
}
