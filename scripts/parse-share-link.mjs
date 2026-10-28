#!/usr/bin/env node
/**
 * Convert one or more `vless://` share links (the text a QR code carries) into
 * the `nodes[]` JSON this plugin accepts:
 *
 *   node scripts/parse-share-link.mjs "vless://uuid@host:443?security=reality&..."
 *
 * Paste the printed array under `nodes:` in cordis.patch.yml, or pass the link
 * directly as `shareLink: "<link>"` and let the plugin parse it at load time.
 */
import { parseShareLinks } from '../lib/share-link.js'

const links = process.argv.slice(2)
if (links.length === 0) {
  console.error('usage: node scripts/parse-share-link.mjs <vless://...> [more links]')
  process.exit(2)
}

const { nodes, errors, warnings } = parseShareLinks(links)
for (const warning of warnings) console.error(`warning: ${warning}`)
for (const error of errors) console.error(`error: ${error.field}: ${error.message}`)
if (nodes.length > 0) console.log(JSON.stringify(nodes, null, 2))
if (errors.length > 0) process.exitCode = 1
