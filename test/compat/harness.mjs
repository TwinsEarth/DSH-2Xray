/**
 * Locates a runnable DSH application tree for the compatibility probes.
 *
 * The probes must import the harness' *own* modules — a fake `ctx` proves the
 * plugin's assumptions, never DSH's behaviour. A plain `node` process cannot
 * resolve specifiers inside `app.asar`, so this module either uses a tree that
 * was already extracted or materialises one with `tools/extract-dsh-app.mjs`.
 *
 * Resolution order:
 *   1. `DSH_APP_ROOT` — a directory that contains `dsh/node_modules/...`
 *   2. `DSH_APP_CACHE` — default `%TEMP%/dsh-2xray-compat`
 *   3. extract from `DSH_ASAR`, or from an auto-detected desktop install
 *
 * When none of those exist the probes skip instead of failing: a machine
 * without the desktop app cannot answer a harness-compatibility question.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { extract, findAsar } from '../../tools/extract-dsh-app.mjs'

const MARKER = ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json']

function hasTree(root) {
  return Boolean(root) && fs.existsSync(path.join(root, ...MARKER))
}

function describe(root) {
  const pkgFile = path.join(root, ...MARKER)
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const modules = path.join(root, 'dsh', 'node_modules')
  return {
    root,
    modules,
    version: pkg.version,
    /** Resolve a package the way the harness itself would, honouring `exports`. */
    require: createRequire(pkgFile),
    packageJson(pkgName) {
      return JSON.parse(fs.readFileSync(this.require.resolve(`${pkgName}/package.json`), 'utf8'))
    },
  }
}

/** @returns the resolved tree, or `undefined` when this machine has none. */
export function resolveApp({ log = () => {} } = {}) {
  const explicit = process.env.DSH_APP_ROOT
  if (hasTree(explicit)) return describe(explicit)

  const cache = process.env.DSH_APP_CACHE ?? path.join(os.tmpdir(), 'dsh-2xray-compat')
  if (hasTree(cache)) return describe(cache)

  const archive = findAsar({})
  if (!archive) return undefined
  log(`extracting ${archive} -> ${cache}`)
  extract({ archive, out: cache, log })
  return hasTree(cache) ? describe(cache) : undefined
}

/** Import a file inside the extracted tree. */
export async function importFile(app, relative) {
  return import(pathToFileURL(path.join(app.modules, ...relative.split('/'))).href)
}

/** Import a harness package by its bare name (honours the package `exports`). */
export async function importPackage(app, name) {
  let file
  try {
    file = app.require.resolve(name)
  } catch (error) {
    throw new Error(`cannot resolve ${name} from ${app.root}: ${String(error.message)}`)
  }
  return import(pathToFileURL(file).href)
}

export const SKIP_MESSAGE =
  'no DSH application tree available (set DSH_ASAR to app.asar, or DSH_APP_ROOT to an extracted tree)'
