/**
 * Browser-side routing: turn the extension config into a PAC script.
 *
 * Chrome can only make routing decisions by host (no geoip/geosite), so the
 * PAC mirrors what can be reproduced locally:
 *   - localhost / private IPs / single-label hosts -> DIRECT
 *   - blacklist -> DIRECT (wins over every mode, same priority as the plugin)
 *   - probe hosts -> PROXY (so latency & exit IP measure the tunnel even in
 *     whitelist mode)
 *   - global      -> PROXY everything else
 *   - whitelist   -> PROXY only whitelisted domains, DIRECT otherwise
 *   - cn-direct   -> DIRECT `.cn` + curated mainland domains, PROXY otherwise
 *
 * The generated script is ES5-only and embeds every list through
 * `JSON.stringify`, so a hostile entry cannot break out into code.
 */

import { CN_DIRECT_DOMAINS, CN_DIRECT_SUFFIXES } from './cn-direct.js'

/** Hosts used by the status probes; always proxied while the extension is on. */
export const PROBE_HOSTS = ['www.google.com', 'www.gstatic.com', 'ipinfo.io', 'api.ipify.org']

export const MODE_LABELS = {
  global: '全局代理',
  whitelist: '白名单模式',
  'cn-direct': 'CN 直连',
}

function normalizeHost(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

/** Suffix match used by both the PAC generator and tests. */
export function domainMatches(host, domain) {
  const h = normalizeHost(host)
  const d = normalizeHost(domain).replace(/^\./, '')
  if (!h || !d) return false
  return h === d || h.endsWith(`.${d}`)
}

/** True for loopback / RFC1918 / link-local / plain hostnames. */
export function isLocalHost(host) {
  const h = normalizeHost(host)
  if (!h) return true
  if (h === 'localhost' || h === 'localhost.localdomain' || h === '::1') return true
  if (h.includes(':')) return false
  if (!h.includes('.')) return true
  for (const suffix of ['.local', '.lan', '.internal', '.corp', '.home.arpa', '.home']) {
    if (h.endsWith(suffix)) return true
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Does a host fall in the cn-direct direct set? */
export function isCnDirectHost(host) {
  const h = normalizeHost(host)
  if (!h) return false
  for (const domain of CN_DIRECT_DOMAINS) {
    if (domainMatches(h, domain)) return true
  }
  for (const suffix of CN_DIRECT_SUFFIXES) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return true
  }
  return false
}

/** `PROXY 127.0.0.1:20808` / `SOCKS5 127.0.0.1:20809` for PAC. */
export function proxyDirective(proxy) {
  const host = String(proxy?.host ?? '127.0.0.1')
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const endpoint = `${bracketed}:${Number(proxy?.port) || 20808}`
  return `${proxy?.protocol === 'socks' ? 'SOCKS5' : 'PROXY'} ${endpoint}`
}

/** Human-readable endpoint, e.g. `http://127.0.0.1:20808`. */
export function describeProxy(proxy) {
  const scheme = proxy?.protocol === 'socks' ? 'socks5' : 'http'
  const host = String(proxy?.host ?? '127.0.0.1')
  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${Number(proxy?.port) || 20808}`
}

/**
 * Chrome requires `pacScript.data` to be ASCII-only ("encode URLs in Punycode
 * format"). JSON.stringify can emit non-ASCII for an unexpected entry, so
 * escape everything outside printable ASCII as \uXXXX (still valid in a JS
 * string literal).
 */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${code}`
  })
}

function jsonList(values) {
  return asciiJson([...new Set(values.map((entry) => normalizeHost(entry)).filter(Boolean))])
}

/**
 * Build the PAC script for a normalized config.
 * @param {object} config
 * @returns {string}
 */
export function buildPac(config) {
  const routing = config.routing ?? {}
  const mode = ['global', 'whitelist', 'cn-direct'].includes(routing.mode) ? routing.mode : 'global'
  const proxy = proxyDirective(config.proxy)
  const blacklist = jsonList(routing.blacklist ?? [])
  const whitelist = jsonList(routing.whitelist ?? [])
  const bypass = jsonList(routing.bypassDomains ?? [])
  const cnDomains = mode === 'cn-direct' ? jsonList(CN_DIRECT_DOMAINS) : '[]'
  const cnSuffixes = mode === 'cn-direct' ? jsonList(CN_DIRECT_SUFFIXES) : '[]'
  const probeHosts = jsonList(PROBE_HOSTS)

  return `// 2Xray Chrome extension - generated PAC. Edit settings in the extension.
var X2_MODE = ${asciiJson(mode)};
var X2_PROXY = ${asciiJson(proxy)};
var X2_DIRECT = "DIRECT";
var X2_BLACKLIST = ${blacklist};
var X2_WHITELIST = ${whitelist};
var X2_BYPASS = ${bypass};
var X2_CN = ${cnDomains};
var X2_CN_SUFFIX = ${cnSuffixes};
var X2_PROBE = ${probeHosts};

function X2_norm(host) {
  host = String(host || "").toLowerCase();
  if (host.charAt(0) === "[") host = host.slice(1);
  if (host.charAt(host.length - 1) === "]") host = host.slice(0, -1);
  if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
  return host;
}

function X2_match(host, domain) {
  if (host === domain) return true;
  var suffix = "." + domain;
  return host.length > suffix.length && host.slice(-suffix.length) === suffix;
}

function X2_in(host, list) {
  for (var i = 0; i < list.length; i++) {
    if (X2_match(host, list[i])) return true;
  }
  return false;
}

function X2_local(host) {
  if (host === "localhost" || host === "localhost.localdomain" || host === "::1") return true;
  if (host.indexOf(":") !== -1) return false;
  if (host.indexOf(".") === -1) return true;
  var suffixes = [".local", ".lan", ".internal", ".corp", ".home.arpa", ".home"];
  for (var i = 0; i < suffixes.length; i++) {
    if (host.length > suffixes[i].length && host.slice(-suffixes[i].length) === suffixes[i]) return true;
  }
  var m = /^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/.exec(host);
  if (m) {
    var a = Number(m[1]);
    var b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function X2_isCn(host) {
  if (X2_in(host, X2_CN)) return true;
  for (var i = 0; i < X2_CN_SUFFIX.length; i++) {
    var suffix = "." + X2_CN_SUFFIX[i];
    if (host.length > suffix.length && host.slice(-suffix.length) === suffix) return true;
  }
  return false;
}

function FindProxyForURL(url, host) {
  host = X2_norm(host);
  if (!host || X2_local(host)) return X2_DIRECT;
  if (X2_in(host, X2_BYPASS)) return X2_DIRECT;
  if (X2_in(host, X2_BLACKLIST)) return X2_DIRECT;
  if (X2_in(host, X2_PROBE)) return X2_PROXY;
  if (X2_MODE === "global") return X2_PROXY;
  if (X2_MODE === "whitelist") {
    return X2_in(host, X2_WHITELIST) ? X2_PROXY : X2_DIRECT;
  }
  if (X2_MODE === "cn-direct") {
    return X2_isCn(host) ? X2_DIRECT : X2_PROXY;
  }
  return X2_PROXY;
}
`
}

/** The `chrome.proxy.settings` value for a normalized config. */
export function buildProxySettings(config) {
  return {
    mode: 'pac_script',
    pacScript: { data: buildPac(config), mandatory: false },
  }
}

/** Compact summary for the popup: proxy string + counts + mode label. */
export function summarizeRouting(config) {
  return {
    mode: config.routing?.mode ?? 'global',
    modeLabel: MODE_LABELS[config.routing?.mode] ?? '全局代理',
    endpoint: describeProxy(config.proxy),
    pacDirective: proxyDirective(config.proxy),
    whitelistCount: config.routing?.whitelist?.length ?? 0,
    blacklistCount: config.routing?.blacklist?.length ?? 0,
    bypassCount: config.routing?.bypassDomains?.length ?? 0,
  }
}
