import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  buildPac,
  buildProxySettings,
  describeProxy,
  domainMatches,
  isCnDirectHost,
  isLocalHost,
  proxyDirective,
} from '../chrome-extension/lib/routing.js'
import { normalizeDomainList, normalizeConfig } from '../chrome-extension/lib/config.js'

function evaluatePac(config) {
  const pac = buildPac(config)
  // Chrome rejects non-ASCII pacScript.data; keep this invariant in tests.
  assert.equal(/[^\x00-\x7f]/.test(pac), false, 'PAC must be ASCII-only')
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(pac, sandbox, { filename: 'generated.pac' })
  assert.equal(typeof sandbox.FindProxyForURL, 'function', 'PAC must define FindProxyForURL')
  return {
    pac,
    resolve: (url, host) => sandbox.FindProxyForURL(url, host),
  }
}

const PROXY_HTTP = 'PROXY 127.0.0.1:20808'

function globalConfig() {
  return normalizeConfig({ enabled: true, routing: { mode: 'global' } }).config
}

function whitelistConfig() {
  return normalizeConfig({ enabled: true, routing: { mode: 'whitelist' } }).config
}

function cnDirectConfig() {
  return normalizeConfig({ enabled: true, routing: { mode: 'cn-direct' } }).config
}

test('normalizeDomainList accepts URLs, wildcards, ports and dedupes', () => {
  const list = normalizeDomainList([
    'https://registry.npmjs.org/',
    'registry.npmjs.org',
    '*.GitHub.com',
    'BAIDU.com:443',
    '  example.com/path  ',
    'not a domain',
    'localhost',
  ])
  assert.deepEqual(list, ['registry.npmjs.org', 'github.com', 'baidu.com', 'example.com'])
})

test('bare labels are allowed only for the bypass list', () => {
  assert.deepEqual(normalizeDomainList(['lan', 'printer.lan'], { allowBare: true }), ['lan', 'printer.lan'])
  assert.deepEqual(normalizeDomainList(['lan', 'printer.lan']), ['printer.lan'])
})

test('domainMatches is suffix-safe', () => {
  assert.equal(domainMatches('github.com', 'github.com'), true)
  assert.equal(domainMatches('api.github.com', 'github.com'), true)
  assert.equal(domainMatches('notgithub.com', 'github.com'), false)
  assert.equal(domainMatches('github.com.evil.com', 'github.com'), false)
  assert.equal(domainMatches('GITHUB.COM', 'github.com'), true)
  assert.equal(domainMatches('api.github.com.', 'github.com'), true)
})

test('isLocalHost covers loopback, RFC1918, link-local and .lan', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.4', '172.20.0.1', '169.254.1.1', 'printer.lan', 'box.local', '::1', 'intranet']) {
    assert.equal(isLocalHost(host), true, host)
  }
  for (const host of ['github.com', '8.8.8.8', '172.32.0.1', 'www.google.com', '2001:db8::1']) {
    assert.equal(isLocalHost(host), false, host)
  }
})

test('cn-direct list covers mainstream mainland sites and .cn', () => {
  for (const host of ['baidu.com', 'www.qq.com', 'bilibili.com', '163.com', 'www.gov.cn', 'mi.com']) {
    assert.equal(isCnDirectHost(host), true, host)
  }
  for (const host of ['github.com', 'google.com', 'youtube.com', 'example.cn.evil.com']) {
    assert.equal(isCnDirectHost(host), false, host)
  }
})

test('proxyDirective supports http and socks', () => {
  assert.equal(proxyDirective({ protocol: 'http', host: '127.0.0.1', port: 20808 }), 'PROXY 127.0.0.1:20808')
  assert.equal(proxyDirective({ protocol: 'socks', host: '127.0.0.1', port: 20809 }), 'SOCKS5 127.0.0.1:20809')
  assert.equal(proxyDirective({ protocol: 'http', host: '::1', port: 20808 }), 'PROXY [::1]:20808')
  assert.equal(describeProxy({ protocol: 'socks', host: '127.0.0.1', port: 20809 }), 'socks5://127.0.0.1:20809')
})

test('global PAC proxies everything except local, bypass and blacklist', () => {
  const { resolve, pac } = evaluatePac(globalConfig())
  assert.ok(pac.length < 200_000)
  assert.equal(resolve('https://github.com/', 'github.com'), PROXY_HTTP)
  assert.equal(resolve('https://www.google.com/', 'www.google.com'), PROXY_HTTP)
  assert.equal(resolve('https://ipinfo.io/json', 'ipinfo.io'), PROXY_HTTP)
  assert.equal(resolve('https://deepseek.com/', 'deepseek.com'), 'DIRECT')
  assert.equal(resolve('http://localhost:3000/', 'localhost'), 'DIRECT')
  assert.equal(resolve('http://printer.lan/', 'printer.lan'), 'DIRECT')
  assert.equal(resolve('http://192.168.1.1/', '192.168.1.1'), 'DIRECT')
  assert.equal(resolve('http://intranet/', 'intranet'), 'DIRECT')
})

test('whitelist PAC proxies only listed domains (subdomains included)', () => {
  const { resolve } = evaluatePac(whitelistConfig())
  assert.equal(resolve('https://github.com/', 'github.com'), PROXY_HTTP)
  assert.equal(resolve('https://api.github.com/user', 'api.github.com'), PROXY_HTTP)
  assert.equal(resolve('https://www.youtube.com/', 'www.youtube.com'), PROXY_HTTP)
  assert.equal(resolve('https://notgithub.com/', 'notgithub.com'), 'DIRECT')
  assert.equal(resolve('https://baidu.com/', 'baidu.com'), 'DIRECT')
  assert.equal(resolve('https://deepseek.com/', 'deepseek.com'), 'DIRECT')
  // Probe hosts stay proxied so status measures the tunnel.
  assert.equal(resolve('https://ipinfo.io/json', 'ipinfo.io'), PROXY_HTTP)
})

test('cn-direct PAC sends .cn and curated sites direct, everything else proxied', () => {
  const { resolve } = evaluatePac(cnDirectConfig())
  assert.equal(resolve('https://www.baidu.com/', 'www.baidu.com'), 'DIRECT')
  assert.equal(resolve('https://www.bilibili.com/', 'www.bilibili.com'), 'DIRECT')
  assert.equal(resolve('https://www.163.com/', 'www.163.com'), 'DIRECT')
  assert.equal(resolve('https://www.gov.cn/', 'www.gov.cn'), 'DIRECT')
  assert.equal(resolve('https://github.com/', 'github.com'), PROXY_HTTP)
  assert.equal(resolve('https://www.youtube.com/', 'www.youtube.com'), PROXY_HTTP)
  assert.equal(resolve('https://www.google.com/', 'www.google.com'), PROXY_HTTP)
  assert.equal(resolve('https://deepseek.com/', 'deepseek.com'), 'DIRECT')
})

test('blacklist wins over whitelist in every mode', () => {
  const config = normalizeConfig({
    enabled: true,
    routing: { mode: 'whitelist', whitelist: ['deepseek.com', 'github.com'] },
  }).config
  const { resolve } = evaluatePac(config)
  assert.equal(resolve('https://deepseek.com/', 'deepseek.com'), 'DIRECT')
  assert.equal(resolve('https://github.com/', 'github.com'), PROXY_HTTP)
})

test('socks proxy is emitted as SOCKS5 in the PAC', () => {
  const config = normalizeConfig({ enabled: true, proxy: { protocol: 'socks', port: 20809 } }).config
  const { resolve, pac } = evaluatePac(config)
  assert.ok(pac.includes('SOCKS5 127.0.0.1:20809'))
  assert.equal(resolve('https://github.com/', 'github.com'), 'SOCKS5 127.0.0.1:20809')
})

test('hostile list entries cannot escape the JSON string', () => {
  const config = normalizeConfig({
    enabled: true,
    routing: { whitelist: ['a.com"; return "PROXY 6.6.6.6:1; //', 'evil.com'] },
  }).config
  const { resolve, pac } = evaluatePac(config)
  // The malicious entry is not a valid host, so it is dropped by normalization.
  assert.equal(config.routing.whitelist.includes('evil.com'), true)
  assert.equal(config.routing.whitelist.some((entry) => entry.includes('6.6.6.6')), false)
  assert.equal(pac.includes('6.6.6.6'), false)
  assert.equal(resolve('https://evil.com/', 'evil.com'), PROXY_HTTP)
})

test('PAC stays ASCII-only with IDN / Unicode settings', () => {
  const config = normalizeConfig({
    enabled: true,
    routing: { mode: 'whitelist', whitelist: ['例子.中国', 'example.com'], bypassDomains: ['局域网'] },
  }).config
  const { pac } = evaluatePac(config)
  assert.equal(/[^\x00-\x7f]/.test(pac), false)
  assert.equal(config.routing.whitelist.includes('example.com'), true)
  assert.equal(config.routing.whitelist.some((entry) => /[^\x00-\x7f]/.test(entry)), false)
})

test('buildProxySettings returns a pac_script value', () => {
  const settings = buildProxySettings(globalConfig())
  assert.equal(settings.mode, 'pac_script')
  assert.equal(typeof settings.pacScript.data, 'string')
  assert.equal(settings.pacScript.mandatory, false)
  assert.match(settings.pacScript.data, /function FindProxyForURL/)
})
