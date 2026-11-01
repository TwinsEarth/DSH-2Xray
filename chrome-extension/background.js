/**
 * 2Xray Chrome extension — background service worker.
 *
 * Owns the single source of truth (`chrome.storage.local`), installs the PAC
 * proxy configuration, probes the tunnel and answers the popup/options pages.
 * No code is fetched at runtime; every network call is a status probe.
 */

import { DEFAULT_CONFIG, applyConfigPatch, normalizeConfig } from './lib/config.js'
import { buildProxySettings, describeProxy, summarizeRouting } from './lib/routing.js'
import { buildShareLink } from './lib/share-link.js'

const CONFIG_KEY = 'config'
const RUNTIME_KEY = 'runtime'
const ALARM_NAME = 'x2ray-probe'
const MAX_LOGS = 100
const LOG_LEVELS = new Set(['info', 'warn', 'error'])

const DEFAULT_RUNTIME = {
  probe: null,
  lastApply: null,
  logs: [],
  installedAt: null,
}

let configCache = null
let probeInFlight = null
let queue = Promise.resolve()

// ---------------------------------------------------------------------------
// chrome.* promise/callback wrappers (proxy settings are callback-only on some
// Chrome builds; storage returns promises in MV3).
// ---------------------------------------------------------------------------

function proxyGet() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve(details)
    })
  })
}

function proxySet(value) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: 'regular' }, () => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve()
    })
  })
}

function proxyClear() {
  return new Promise((resolve) => {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
      // "Proxy settings not set" is not a failure for our purposes.
      void chrome.runtime.lastError
      resolve()
    })
  })
}

async function storageGet(key) {
  const bag = await chrome.storage.local.get(key)
  return bag[key]
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value })
}

/** Serialize mutations so two popup clicks cannot interleave. */
function enqueue(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------------------
// Config + runtime persistence
// ---------------------------------------------------------------------------

async function readConfig() {
  if (configCache) return configCache
  const stored = await storageGet(CONFIG_KEY)
  const normalized = normalizeConfig(stored)
  configCache = normalized
  if (!stored) await storageSet(CONFIG_KEY, normalized.config)
  return normalized
}

async function writeConfig(config) {
  const normalized = normalizeConfig(config)
  if (normalized.errors.length > 0) return normalized
  configCache = normalized
  await storageSet(CONFIG_KEY, normalized.config)
  return normalized
}

async function readRuntime() {
  const stored = await storageGet(RUNTIME_KEY)
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_RUNTIME, logs: [] }
  return {
    ...DEFAULT_RUNTIME,
    ...stored,
    logs: Array.isArray(stored.logs) ? stored.logs.slice(-MAX_LOGS) : [],
  }
}

async function writeRuntime(patch) {
  const current = await readRuntime()
  const next = { ...current, ...patch }
  if (Array.isArray(next.logs) && next.logs.length > MAX_LOGS) next.logs = next.logs.slice(-MAX_LOGS)
  await storageSet(RUNTIME_KEY, next)
  return next
}

async function log(level, message) {
  const entry = {
    t: Date.now(),
    level: LOG_LEVELS.has(level) ? level : 'info',
    msg: String(message ?? '').slice(0, 500),
  }
  const current = await readRuntime()
  const logs = current.logs.concat(entry).slice(-MAX_LOGS)
  await writeRuntime({ logs })
  return entry
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function updateBadge(config, runtime) {
  let text = ''
  let color = '#6b7280'
  let title = '2Xray — 已关闭（点击开启）'
  if (config.enabled) {
    const probe = runtime?.probe
    if (!probe) {
      text = 'ON'
      color = '#2563eb'
      title = '2Xray — 已开启，等待首次探测'
    } else if (probe.ok) {
      text = 'ON'
      color = '#15803d'
      const exit = probe.exit?.ip ? ` · 出口 ${probe.exit.ip}` : ''
      title = `2Xray — 已连接 · ${probe.latencyMs}ms${exit}`
    } else {
      text = '!'
      color = '#c81e1e'
      title = `2Xray — 已开启，但探测失败：${probe.error ?? '未知错误'}`
    }
  }
  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setTitle({ title })
}

// ---------------------------------------------------------------------------
// Proxy install / remove
// ---------------------------------------------------------------------------

let appliedSignature = null

function configSignature(config) {
  return JSON.stringify({
    enabled: config.enabled,
    proxy: config.proxy,
    routing: config.routing,
    probe: { latencyUrl: config.probe?.latencyUrl },
  })
}

async function applyProxy(config, { reason = '' } = {}) {
  const signature = configSignature(config)
  if (!config.enabled) {
    await proxyClear()
    appliedSignature = signature
    const runtime = await writeRuntime({
      lastApply: { enabled: false, appliedAt: Date.now(), endpoint: describeProxy(config.proxy), reason },
    })
    await updateBadge(config, runtime)
    return { ok: true, enabled: false }
  }

  if (appliedSignature === signature) {
    const details = await proxyGet().catch(() => null)
    if (details?.levelOfControl === 'controlled_by_this_extension') {
      return { ok: true, enabled: true, skipped: true }
    }
  }

  try {
    await proxySet(buildProxySettings(config))
  } catch (error) {
    const message = error?.message ?? String(error)
    await log('error', `安装代理设置失败：${message}`)
    const runtime = await writeRuntime({
      lastApply: { enabled: true, appliedAt: Date.now(), error: message, reason },
    })
    await updateBadge(config, runtime)
    return { ok: false, error: message }
  }

  const details = await proxyGet().catch(() => null)
  const level = details?.levelOfControl ?? 'unknown'
  if (level !== 'controlled_by_this_extension') {
    const message =
      level === 'controlled_by_other_extensions'
        ? '代理设置被其他扩展接管，请先关闭其他代理扩展'
        : `浏览器未接受代理设置（levelOfControl=${level}）`
    await log('error', message)
    const runtime = await writeRuntime({
      lastApply: { enabled: true, levelOfControl: level, appliedAt: Date.now(), error: message, reason },
    })
    await updateBadge(config, runtime)
    return { ok: false, error: message }
  }

  appliedSignature = signature
  const pac = buildProxySettings(config).pacScript.data
  const runtime = await writeRuntime({
    lastApply: {
      enabled: true,
      appliedAt: Date.now(),
      endpoint: describeProxy(config.proxy),
      mode: config.routing.mode,
      levelOfControl: level,
      pacBytes: pac.length,
      reason,
    },
  })
  await log('info', `代理已启用：${summarizeRouting(config).modeLabel} · ${describeProxy(config.proxy)}`)
  await updateBadge(config, runtime)
  return { ok: true, enabled: true }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const started = Date.now()
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    })
    return { response, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function parseExitPayload(text, contentType, sourceUrl) {
  const trimmed = String(text ?? '').trim()
  let json = null
  try {
    json = JSON.parse(trimmed)
  } catch {
    json = null
  }
  if (json && typeof json === 'object') {
    const ip = json.ip || json.query || json.YourFuckingIPAddress
    if (ip) {
      return {
        ip: String(ip),
        country: json.country_name || json.country || '',
        region: json.region || json.region_name || '',
        city: json.city || '',
        org: json.org || json.asn || json.connection?.org || json.isp || '',
        source: sourceUrl,
      }
    }
  }
  const match = /((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})/i.exec(trimmed)
  if (match) return { ip: match[1], country: '', region: '', city: '', org: '', source: sourceUrl }
  throw new Error('出口 IP 响应无法解析')
}

async function probeExit(timeoutMs) {
  const primary = 'https://ipinfo.io/json'
  const fallback = 'https://api.ipify.org?format=json'
  let lastError = null
  for (const url of [primary, fallback]) {
    try {
      const { response, elapsedMs } = await fetchWithTimeout(url, timeoutMs)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const exit = parseExitPayload(text, response.headers.get('content-type'), url)
      return { ...exit, elapsedMs }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('出口 IP 探测失败')
}

async function runProbe(config) {
  if (probeInFlight) return probeInFlight
  probeInFlight = (async () => {
    const timeoutMs = Math.max(1000, Math.min(30000, Number(config.probe.timeoutMs) || 8000))
    let ok = false
    let latencyMs = null
    let status = null
    let error = null
    try {
      const { response, elapsedMs } = await fetchWithTimeout(config.probe.latencyUrl, timeoutMs)
      latencyMs = elapsedMs
      status = response.status
      ok = response.ok
      if (!ok) error = `HTTP ${status}`
    } catch (cause) {
      error =
        cause?.name === 'AbortError'
          ? `连接超时（${timeoutMs}ms）`
          : String(cause?.message ?? cause)
    }

    let exit = null
    let exitError = null
    if (ok) {
      try {
        exit = await probeExit(timeoutMs)
      } catch (cause) {
        exitError = String(cause?.message ?? cause)
      }
    }

    const probe = {
      ok,
      latencyMs,
      status,
      error,
      exit,
      exitError,
      checkedAt: Date.now(),
      enabled: config.enabled,
      mode: config.routing.mode,
      endpoint: describeProxy(config.proxy),
      direct: !config.enabled,
    }
    const runtime = await writeRuntime({ probe })
    await updateBadge(config, runtime)
    if (!ok) await log('warn', `探测失败：${error ?? '未知错误'}`)
    return probe
  })().finally(() => {
    probeInFlight = null
  })
  return probeInFlight
}

// ---------------------------------------------------------------------------
// Alarms / lifecycle
// ---------------------------------------------------------------------------

async function ensureAlarm(config) {
  const period = Math.max(1, Math.min(60, Number(config.probe.intervalMinutes) || 2))
  await chrome.alarms.clear(ALARM_NAME)
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period, delayInMinutes: period })
}

async function getState() {
  const normalized = await readConfig()
  const runtime = await readRuntime()
  const details = await proxyGet().catch(() => null)
  const config = normalized.config
  return {
    config,
    errors: normalized.errors,
    warnings: normalized.warnings,
    runtime,
    summary: summarizeRouting(config),
    profileLink: config.profile.node ? buildShareLink(config.profile.node) : '',
    proxy: {
      levelOfControl: details?.levelOfControl ?? 'unknown',
      mode: details?.value?.mode ?? 'system',
    },
    meta: {
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
    },
  }
}

async function setEnabled(enabled) {
  const normalized = await readConfig()
  const next = applyConfigPatch(normalized.config, { enabled: Boolean(enabled) })
  const saved = await writeConfig(next)
  if (saved.errors.length > 0) return { ok: false, errors: saved.errors }
  const config = saved.config
  const applied = await applyProxy(config, { reason: enabled ? 'user-enable' : 'user-disable' })
  if (enabled) await runProbe(config)
  const state = await getState()
  return { ok: applied.ok !== false, state, applied, warnings: saved.warnings }
}

async function saveConfig(patch) {
  const normalized = await readConfig()
  const next = applyConfigPatch(normalized.config, patch)
  const saved = await writeConfig(next)
  if (saved.errors.length > 0) return { ok: false, errors: saved.errors, warnings: saved.warnings }
  const config = saved.config
  await ensureAlarm(config)
  if (config.enabled) {
    await applyProxy(config, { reason: 'settings-save' })
    await runProbe(config)
  } else {
    await updateBadge(config, await readRuntime())
  }
  await log('info', '设置已保存')
  return { ok: true, state: await getState(), warnings: saved.warnings }
}

async function importLink(link) {
  const normalized = await readConfig()
  const next = applyConfigPatch(normalized.config, { profile: { shareLink: String(link ?? '').trim() } })
  const saved = await writeConfig(next)
  const profileErrors = saved.errors.filter((entry) => entry.field.startsWith('profile.'))
  if (profileErrors.length > 0) return { ok: false, errors: profileErrors, warnings: saved.warnings }
  const config = saved.config
  await log('info', `已导入节点：${config.profile.name || '(未命名)'}（${config.profile.node?.address}:${config.profile.node?.port}）`)
  return { ok: true, state: await getState(), warnings: saved.warnings }
}

async function clearProfile() {
  const normalized = await readConfig()
  const next = applyConfigPatch(normalized.config, { profile: { shareLink: '', node: null, name: '' } })
  const saved = await writeConfig(next)
  await log('info', '已清空 VLESS 节点')
  return { ok: saved.errors.length === 0, state: await getState(), errors: saved.errors }
}

async function resetAll() {
  const { config } = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
  configCache = { config, errors: [], warnings: [] }
  await storageSet(CONFIG_KEY, config)
  appliedSignature = null
  await applyProxy(config, { reason: 'reset' })
  await ensureAlarm(config)
  await writeRuntime({ probe: null, lastApply: null, logs: [] })
  await log('info', '已恢复默认设置')
  return { ok: true, state: await getState() }
}

// ---------------------------------------------------------------------------
// Message API
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  switch (message?.type) {
    case 'state':
      return { ok: true, state: await getState() }
    case 'set-enabled':
      return enqueue(() => setEnabled(message.enabled))
    case 'save-config':
      return enqueue(() => saveConfig(message.patch ?? {}))
    case 'import-link':
      return enqueue(() => importLink(message.link))
    case 'clear-profile':
      return enqueue(() => clearProfile())
    case 'reset':
      return enqueue(() => resetAll())
    case 'apply':
      return enqueue(async () => {
        const { config } = await readConfig()
        const applied = await applyProxy(config, { reason: 'manual-apply' })
        if (config.enabled) await runProbe(config)
        return { ok: applied.ok !== false, state: await getState(), applied }
      })
    case 'probe':
      return enqueue(async () => {
        const { config } = await readConfig()
        const probe = await runProbe(config)
        return { ok: true, probe, state: await getState() }
      })
    case 'open-options':
      chrome.runtime.openOptionsPage()
      return { ok: true }
    default:
      return { ok: false, error: `未知消息：${message?.type ?? '(empty)'}` }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }))
  return true
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-proxy') return
  enqueue(async () => {
    const { config } = await readConfig()
    await setEnabled(!config.enabled)
  }).catch((error) => log('error', `快捷键切换失败：${String(error?.message ?? error)}`))
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  enqueue(async () => {
    const { config } = await readConfig()
    if (!config.enabled) return
    await runProbe(config)
  }).catch((error) => log('error', `定时探测失败：${String(error?.message ?? error)}`))
})

chrome.proxy.onProxyError.addListener((details) => {
  log('error', `代理错误：${details.error} ${details.details ?? ''}`.trim()).catch(() => {})
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  const normalized = await readConfig()
  await ensureAlarm(normalized.config)
  await applyProxy(normalized.config, { reason: 'boot' })
  if (normalized.config.enabled) await runProbe(normalized.config)
  const runtime = await readRuntime()
  if (!runtime.installedAt) await writeRuntime({ installedAt: Date.now() })
  await updateBadge(normalized.config, runtime)
}

chrome.runtime.onInstalled.addListener(() => {
  enqueue(init).catch((error) => console.error('2Xray init failed', error))
})

chrome.runtime.onStartup.addListener(() => {
  enqueue(init).catch((error) => console.error('2Xray startup failed', error))
})

const ready = enqueue(init).catch((error) => {
  console.error('2Xray init failed', error)
})

// Expose a tiny diagnostic hook for chrome://extensions console users.
globalThis.__x2ray = { getState, runProbe, applyProxy, ready }
