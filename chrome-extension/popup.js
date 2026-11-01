/**
 * Popup: three-card view of the same state the DSH plugin panel shows —
 * connection, active VLESS profile (with link QR), routing + recent log.
 * All rendering uses textContent / DOM nodes, never HTML strings.
 */

import { drawQr } from './lib/qr.js'

const $ = (id) => document.getElementById(id)

const els = {
  power: $('power'),
  subtitle: $('subtitle'),
  banner: $('banner'),
  pill: $('pill'),
  pillText: $('pill-text'),
  endpoint: $('endpoint'),
  modeLabel: $('mode-label'),
  latency: $('latency'),
  exit: $('exit'),
  checked: $('checked'),
  statusError: $('status-error'),
  qr: $('qr'),
  profileName: $('profile-name'),
  profileServer: $('profile-server'),
  profileChips: $('profile-chips'),
  profileHint: $('profile-hint'),
  copyLink: $('copy-link'),
  counts: $('counts'),
  modeSelect: $('mode-select'),
  log: $('log'),
  probe: $('probe'),
  options: $('options'),
  openOptions: $('open-options'),
  version: $('version'),
}

const MODE_LABELS = {
  global: '全局代理',
  whitelist: '白名单模式',
  'cn-direct': 'CN 直连',
}

const SECURITY_LABELS = { reality: 'REALITY', tls: 'TLS', none: '无加密' }

let state = null
let busy = false
let bannerError = ''
let copyTimer = null

function send(message) {
  return chrome.runtime.sendMessage(message)
}

function fmtTime(ts) {
  if (!ts) return '—'
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function setPill(cls, text) {
  els.pill.className = `pill ${cls || ''}`.trim()
  els.pillText.textContent = text
}

function showBanner(text, kind = 'warn') {
  bannerError = text || ''
  if (!text) {
    els.banner.classList.add('hidden')
    els.banner.textContent = ''
    return
  }
  els.banner.classList.remove('hidden')
  els.banner.classList.toggle('error', kind === 'error')
  els.banner.textContent = text
}

function renderStatus(s) {
  const config = s.config
  const probe = s.runtime?.probe
  const lastApply = s.runtime?.lastApply

  if (!config.enabled) {
    setPill('', '未启用')
  } else if (s.errors.length > 0) {
    setPill('red', '配置错误')
  } else if (lastApply?.error) {
    setPill('red', '代理安装失败')
  } else if (!probe) {
    setPill('blue', '已开启 · 检测中')
  } else if (probe.ok) {
    setPill('green', '已连接')
  } else {
    setPill('red', '内核未响应')
  }

  els.endpoint.textContent = s.summary.endpoint
  els.modeLabel.textContent = MODE_LABELS[s.summary.mode] ?? s.summary.mode
  els.latency.textContent =
    probe && probe.latencyMs !== null ? `${probe.latencyMs} ms` : probe ? '失败' : '—'
  if (probe?.exit?.ip) {
    const where = [probe.exit.country, probe.exit.org].filter(Boolean).join(' · ')
    els.exit.textContent = where ? `${probe.exit.ip} · ${where}` : probe.exit.ip
    els.exit.title = where
  } else if (probe?.exitError) {
    els.exit.textContent = 'IP 获取失败'
    els.exit.title = probe.exitError
  } else {
    els.exit.textContent = '—'
    els.exit.title = ''
  }
  els.checked.textContent = probe?.checkedAt ? fmtTime(probe.checkedAt) : '—'

  const messages = []
  if (s.errors.length > 0) messages.push(s.errors[0].message)
  if (lastApply?.error) messages.push(lastApply.error)
  if (config.enabled && probe && !probe.ok) messages.push(probe.error || '探测失败')
  if (s.proxy.levelOfControl === 'controlled_by_other_extensions') {
    messages.push('代理设置被其他扩展接管')
  }
  if (messages.length > 0) {
    els.statusError.textContent = messages.slice(0, 2).join('；')
    els.statusError.classList.remove('hidden')
  } else {
    els.statusError.textContent = ''
    els.statusError.classList.add('hidden')
  }
}

function renderProfile(s) {
  const node = s.config.profile.node
  els.profileName.textContent = node ? node.id : '未导入 VLESS 链接'
  els.profileServer.textContent = node ? `${node.address}:${node.port}` : '—'
  els.profileChips.replaceChildren()
  if (node) {
    const chips = [
      { text: SECURITY_LABELS[node.security] ?? node.security, cls: node.security },
      node.flow ? { text: node.flow.includes('udp443') ? 'Vision · UDP443' : 'Vision', cls: '' } : null,
      node.serverName ? { text: `SNI ${node.serverName}`, cls: '' } : null,
    ].filter(Boolean)
    for (const chip of chips) {
      const span = document.createElement('span')
      span.className = `chip ${chip.cls || ''}`.trim()
      span.textContent = chip.text
      span.title = chip.text
      els.profileChips.append(span)
    }
  }
  els.copyLink.disabled = !node
  els.profileHint.textContent = node
    ? '导入只保存到扩展；Xray 内核需使用同一节点，可在设置页生成配置。'
    : '先由 DSH-2Xray / v2rayN 提供本地入站，再导入 vless:// 链接。'

  const canvas = els.qr
  if (!node || !s.profileLink) {
    canvas.classList.add('empty')
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    canvas.title = '暂无节点'
    return
  }
  try {
    drawQr(canvas, s.profileLink, { size: 220 })
    canvas.classList.remove('empty')
    canvas.title = '扫码即可把节点导入手机 / 其他客户端'
  } catch (error) {
    canvas.classList.add('empty')
    canvas.title = `二维码生成失败：${String(error?.message ?? error)}`
  }
}

function renderRouting(s) {
  const routing = s.config.routing
  els.counts.textContent = `白 ${routing.whitelist.length} · 黑 ${routing.blacklist.length} · 直连 ${routing.bypassDomains.length}`
  if (els.modeSelect.value !== routing.mode) els.modeSelect.value = routing.mode
  els.modeSelect.disabled = busy
}

function renderLog(s) {
  const logs = (s.runtime?.logs ?? []).slice(-8).reverse()
  els.log.replaceChildren()
  if (logs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'log-empty'
    empty.textContent = '暂无日志'
    els.log.append(empty)
    return
  }
  for (const entry of logs) {
    const line = document.createElement('div')
    line.className = `log-line ${entry.level || 'info'}`.trim()
    const time = document.createElement('span')
    time.className = 't'
    time.textContent = fmtTime(entry.t)
    const text = document.createElement('span')
    text.textContent = entry.msg
    line.append(time, text)
    els.log.append(line)
  }
}

function renderWarnings(s) {
  if (bannerError) return
  if (s.errors.length > 0) {
    showBanner(`${s.errors[0].message}${s.errors.length > 1 ? `（共 ${s.errors.length} 条）` : ''}`, 'error')
  } else if (s.warnings.length > 0) {
    showBanner(s.warnings[0])
  } else {
    showBanner('')
  }
}

function render(s) {
  state = s
  els.power.checked = Boolean(s.config.enabled)
  els.power.disabled = busy
  els.subtitle.textContent = s.config.enabled ? '正在接管浏览器流量' : '未接管浏览器流量'
  els.version.textContent = `v${s.meta.version}`
  renderStatus(s)
  renderProfile(s)
  renderRouting(s)
  renderLog(s)
  renderWarnings(s)
}

async function refresh() {
  try {
    const result = await send({ type: 'state' })
    if (result?.ok !== false && result?.state) render(result.state)
  } catch (error) {
    showBanner(`读取状态失败：${String(error?.message ?? error)}`, 'error')
  }
}

function applyResult(result, fallbackError) {
  if (!result) {
    showBanner(fallbackError || '扩展未响应', 'error')
    return false
  }
  if (result.state) render(result.state)
  if (result.ok === false) {
    const message =
      result.errors?.[0]?.message ||
      result.error ||
      fallbackError ||
      '操作失败'
    showBanner(message, 'error')
    return false
  }
  bannerError = ''
  renderWarnings(state)
  return true
}

async function withBusy(task) {
  if (busy) return
  busy = true
  els.power.disabled = true
  els.probe.disabled = true
  els.modeSelect.disabled = true
  try {
    await task()
  } finally {
    busy = false
    els.power.disabled = false
    els.probe.disabled = false
    els.modeSelect.disabled = false
  }
}

els.power.addEventListener('change', () => {
  const enabled = els.power.checked
  withBusy(async () => {
    const result = await send({ type: 'set-enabled', enabled })
    applyResult(result, '切换代理失败')
    if (!result?.ok) els.power.checked = Boolean(state?.config.enabled)
  })
})

els.modeSelect.addEventListener('change', () => {
  const mode = els.modeSelect.value
  withBusy(async () => {
    const result = await send({ type: 'save-config', patch: { routing: { mode } } })
    if (!applyResult(result, '切换分流模式失败')) {
      els.modeSelect.value = state?.config.routing.mode ?? 'global'
    }
  })
})

els.probe.addEventListener('click', () => {
  withBusy(async () => {
    els.probe.textContent = '测试中…'
    try {
      const result = await send({ type: 'probe' })
      applyResult(result, '探测失败')
    } finally {
      els.probe.textContent = '立即测试'
    }
  })
})

els.copyLink.addEventListener('click', async () => {
  const link = state?.profileLink
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    els.copyLink.textContent = '已复制'
  } catch {
    // Clipboard permission can be denied; fall back to a temporary textarea.
    const area = document.createElement('textarea')
    area.value = link
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    els.copyLink.textContent = '已复制'
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    els.copyLink.textContent = '复制链接'
  }, 1400)
})

for (const button of [els.options, els.openOptions]) {
  button.addEventListener('click', () => send({ type: 'open-options' }))
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes.config && !changes.runtime) return
  refresh()
})

refresh()
setInterval(refresh, 5000)
