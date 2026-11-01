#!/usr/bin/env node
/**
 * Rebuild chrome-extension/vendor/qrcode.js from the upstream MIT QRCode
 * sources (qrcode-generator / qrcode-terminal `vendor/QRCode`).
 *
 *   node scripts/vendor-qr-bundle.mjs --src /path/to/QRCode
 *
 * The output is committed; this script exists so the bundle can be reproduced
 * and audited without a build-time dependency on a package manager.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const OUT = join(ROOT, 'chrome-extension', 'vendor', 'qrcode.js')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const src = resolve(arg('src', join(ROOT, '..', 'qrcode-generator', 'vendor', 'QRCode')))
const files = [
  'QRMode.js',
  'QRMath.js',
  'QRPolynomial.js',
  'QR8bitByte.js',
  'QRBitBuffer.js',
  'QRErrorCorrectLevel.js',
  'QRMaskPattern.js',
  'QRRSBlock.js',
  'QRUtil.js',
  'index.js',
]

const parts = []
for (const file of files) {
  let source
  try {
    source = readFileSync(join(src, file), 'utf8')
  } catch (error) {
    console.error(`cannot read ${join(src, file)}: ${error.message}`)
    console.error('Pass --src <dir containing the upstream QRCode modules>.')
    process.exit(1)
  }
  parts.push(`define(${JSON.stringify('./' + file.replace(/\.js$/, ''))}, function (module, exports, require) {\n${source}\n})`)
}

const header = `/*!
 * QRCode for JavaScript — vendored build for the 2Xray Chrome extension.
 *
 * Copyright (c) 2009 Kazuhiko Arase
 * URL: http://www.d-project.com/
 * Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
 *
 * "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
 * Source: qrcode-generator / qrcode-terminal vendor/QRCode (MIT).
 * Bundled by scripts/vendor-qr-bundle.mjs; do not edit by hand.
 */
`

const body = `${header}(function (root) {
  'use strict'
  var modules = Object.create(null)
  var cache = Object.create(null)

  function define(id, factory) {
    modules[id] = factory
  }

  function require(id) {
    if (cache[id]) return cache[id].exports
    if (!modules[id]) throw new Error('QRCode module not found: ' + id)
    var module = { exports: {} }
    cache[id] = module
    modules[id](module, module.exports, require)
    return module.exports
  }

${parts.join('\n\n')}

  var QRCode = require('./index')

  /** UTF-8 text -> binary string, one char per byte (QR 8-bit mode input). */
  function toBinaryString(text) {
    if (typeof TextEncoder === 'function') {
      var bytes = new TextEncoder().encode(String(text))
      var out = ''
      for (var i = 0; i < bytes.length; i += 0x2000) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000))
      }
      return out
    }
    return unescape(encodeURIComponent(String(text)))
  }

  var LEVELS = { L: 1, M: 0, Q: 3, H: 2 }

  /**
   * Encode text and return a QRCode instance.
   * @param {string} text
   * @param {{errorCorrectLevel?: 'L'|'M'|'Q'|'H'}} [options]
   */
  QRCode.encodeText = function (text, options) {
    var level = LEVELS[(options && options.errorCorrectLevel) || 'M'] ?? LEVELS.M
    var qr = new QRCode(0, level)
    qr.addData(toBinaryString(text))
    qr.make()
    return qr
  }

  QRCode.toBinaryString = toBinaryString

  root.QRCode = QRCode
})(typeof globalThis !== 'undefined' ? globalThis : this)
`

writeFileSync(OUT, body)
console.log(`wrote ${OUT} (${body.length} bytes)`)
