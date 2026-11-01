/**
 * Options page: connection, PAC routing, VLESS profile + QR import, generated
 * xray-core config, settings import/export. No HTML-string rendering: every
 * dynamic value goes through textContent.
 */

import { drawQr } from './lib/qr.js'
import { buildXrayConfigFromConfig } from './lib/xray-config.js'

const $ = (id) => document.getElementById(id)

const MODE_LABELS = {
  global: '全局代理',
  whitelist: '白名单模式',
  'cn-direct': 'CN 直连',
}

const LEVEL_LABELS = {
  controlled_by_this_extension: '由 2Xray 接管',
  controlled_by_other_extensions: '被其他扩展接管',
  controllable_by_this_extension: '未接管（可接管）',
  not_controllable: '受系统策略限制',
  unknown: '状态未知',
}

const els = {
  statusLine: $('status-line'),
  banner: $('banner'),
  saveState: $('save-state'),
  save: $('save'),
  proxyLevel: $('proxy-level'),
  protocol: $('proxy-protocol'),
  host: $('proxy-host'),
  port: $('proxy-port'),
  endpointPreview: $('endpoint-preview'),
  routingSummary: $('routing-summary'),
  whitelist: $('whitelist'),
  blacklist: $('blacklist'),
  bypass: $('bypass'),
  profileTag: $('profile-tag'),
  shareLink: $('share-link'),
  importLink: $('import-link'),
  clearLink: $('clear-link'),
  copyLink: $('copy-link'),
  qrFile: $('qr-file'),
  cameraStart: $('camera-start'),
  cameraStop: $('camera-stop'),
  scanStatus: $('scan-status'),
  qr: $('qr'),
  video: $('video'),
  nodeName: $('node-name'),
  nodeAddress: $('node-address'),
  nodeSecurity: $('node-security'),
  nodeSni: $('node-sni'),
  nodeFlow: $('node-flow'),
  nodeFp: $('node-fp'),
  nodeUuid: $('node-uuid'),
  nodeSid: $('node-sid'),
  configTag: $('config-tag'),
  configHint: $('config-hint'),
  configPreview: $('config-preview'),
  generateConfig: $('generate-config'),
  downloadConfig: $('download-config'),
  copyConfig: $('copy-config'),
  runCommand: $('run-command'),
  probeTimeout: $('probe-timeout'),
  probeInterval: $('probe-interval'),
  exportSettings: $('export-settings'),
  importSettings: $('import-settings'),
  reset: $('reset'),
  versionTag: $('version-tag'),
  extensionId: $('extension-id'),
}

const FORM_IDS = [
  'proxy-protocol',
  'proxy-host',
  'proxy-port',
  'whitelist',
  'blacklist',
  'bypass',
  'probe-timeout',
  'probe-interval',
  'share-link',
]

let state = null
let formDirty = false
let generated = null
let cameraStream = null
let cameraTimer = null
let refreshTimer = null
let savedTimer = null

function send(message) {
  return chrome.runtime.sendMessage(message)
}

function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function joinLines(values) {
  return (values ?? []).join('\n')
}

function fmtTime(ts) {
  if (!ts) return '—'
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function banner(text, kind = 'warn') {
  if (!text) {
    els.banner.classList.add('hidden')
    els.banner.textContent = ''
    return
  }
  els.banner.classList.remove('hidden')
  els.banner.classList.toggle('error', kind === 'error')
  els.banner.textContent = text
}

function setSaveState(kind, text) {
  els.saveState.className = `save-state ${kind || ''}`.trim()
  els.saveState.textContent = text
  clearTimeout(savedTimer)
  if (kind === 'ok') {
    savedTimer = setTimeout(() => {
      els.saveState.className = 'save-state'
      els.saveState.textContent = ''
    }, 2500)
  }
}

function setScanStatus(text, kind = '') {
  els.scanStatus.className = `scan-status ${kind}`.trim()
  els.scanStatus.textContent = text || ''
}

function updateEndpointPreview() {
  const protocol = els.protocol.value === 'socks' ? 'socks5' : 'http'
  const host = els.host.value.trim() || '127.0.0.1'
  const port = Number(els.port.value) || 20808
  const bracketed = host.includes(':') ? `[${host}]` : host
  els.endpointPreview.textContent = `${protocol}://${bracketed}:${port}`
}

function updateStatus(state) {
  const { config, proxy, meta, summary } = state
  const level = LEVEL_LABELS[proxy.levelOfControl] ?? proxy.levelOfControl
  els.statusLine.textContent = `${config.enabled ? '代理已开启' : '代理未开启'} · ${level} · ${MODE_LABELS[config.routing.mode]}`
  els.proxyLevel.textContent = level
  els.routingSummary.textContent = `白 ${config.routing.whitelist.length} · 黑 ${config.routing.blacklist.length} · 直连 ${config.routing.bypassDomains.length}`
  els.versionTag.textContent = `v${meta.version}`
  els.extensionId.textContent = meta.extensionId
  els.runCommand.textContent = 'xray run -c config.json'
  void summary
}

function setFact(element, value, title) {
  element.textContent = value || '—'
  element.title = title ?? value ?? ''
}

function renderProfile(state) {
  const node = state.config.profile.node
  els.profileTag.textContent = node
    ? `${node.security.toUpperCase()} · ${node.address}:${node.port}`
    : '未导入'
  if (!node) {
    setFact(els.nodeName, '未导入 VLESS 节点')
    for (const element of [els.nodeAddress, els.nodeSecurity, els.nodeSni, els.nodeFlow, els.nodeFp, els.nodeUuid, els.nodeSid]) {
      setFact(element, '—')
    }
    const ctx = els.qr.getContext('2d')
    els.qr.classList.add('empty')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, els.qr.width, els.qr.height)
    els.qr.title = '暂无节点'
    return
  }
  setFact(els.nodeName, node.id)
  setFact(els.nodeAddress, `${node.address}:${node.port}`)
  setFact(els.nodeSecurity, `${node.security}${node.flow ? ' · Vision' : ''}`)
  setFact(els.nodeSni, node.serverName)
  setFact(els.nodeFlow, node.flow || '无')
  setFact(els.nodeFp, node.fingerprint || '无')
  setFact(els.nodeUuid, node.uuid)
  setFact(els.nodeSid, node.shortId || '无')

  if (!state.profileLink) {
    els.qr.classList.add('empty')
    els.qr.title = '当前节点无法重建分享链接'
    return
  }
  try {
    drawQr(els.qr, state.profileLink, { size: 440 })
    els.qr.classList.remove('empty')
    els.qr.title = '扫码导入手机 / 其他客户端'
  } catch (error) {
    els.qr.classList.add('empty')
    els.qr.title = `二维码生成失败：${String(error?.message ?? error)}`
  }
}

function populateForm(state, { force = false } = {}) {
  if (!force && formDirty) return
  const config = state.config
  els.protocol.value = config.proxy.protocol
  els.host.value = config.proxy.host
  els.port.value = String(config.proxy.port)
  const modeInput = document.querySelector(`input[name="mode"][value="${config.routing.mode}"]`)
  if (modeInput) modeInput.checked = true
  els.whitelist.value = joinLines(config.routing.whitelist)
  els.blacklist.value = joinLines(config.routing.blacklist)
  els.bypass.value = joinLines(config.routing.bypassDomains)
  els.probeTimeout.value = String(config.probe.timeoutMs)
  els.probeInterval.value = String(config.probe.intervalMinutes)
  els.shareLink.value = config.profile.shareLink
  updateEndpointPreview()
}

function render(next, { forceForm = false } = {}) {
  state = next
  updateStatus(next)
  renderProfile(next)
  populateForm(next, { force: forceForm })
}

async function refresh({ forceForm = false } = {}) {
  try {
    const result = await send({ type: 'state' })
    if (result?.ok === false || !result?.state) {
      banner(result?.error || '读取状态失败', 'error')
      return
    }
    render(result.state, { forceForm })
    if (!formDirty) setSaveState('', '')
  } catch (error) {
    banner(`读取状态失败：${String(error?.message ?? error)}`, 'error')
  }
}

function collectPatch() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'global'
  return {
    proxy: {
      protocol: els.protocol.value,
      host: els.host.value.trim(),
      port: Number(els.port.value),
    },
    routing: {
      mode,
      whitelist: splitLines(els.whitelist.value),
      blacklist: splitLines(els.blacklist.value),
      bypassDomains: splitLines(els.bypass.value),
    },
    probe: {
      timeoutMs: Number(els.probeTimeout.value),
      intervalMinutes: Number(els.probeInterval.value),
    },
  }
}

function invalidateGenerated() {
  generated = null
  els.configPreview.hidden = true
  els.configPreview.textContent = ''
  els.configHint.textContent = '设置已变更，请重新生成。'
  els.configTag.textContent = '—'
  els.downloadConfig.disabled = false
  els.copyConfig.disabled = false
}

async function save() {
  els.save.disabled = true
  setSaveState('', '保存中…')
  try {
    const result = await send({ type: 'save-config', patch: collectPatch() })
    if (!result?.ok) {
      const message = result?.errors?.[0]?.message || result?.error || '保存失败'
      setSaveState('error', '保存失败')
      banner(message, 'error')
      return
    }
    formDirty = false
    render(result.state, { forceForm: true })
    setSaveState('ok', '已保存')
    banner(result.warnings?.[0] || '')
    invalidateGenerated()
  } catch (error) {
    setSaveState('error', '保存失败')
    banner(`保存失败：${String(error?.message ?? error)}`, 'error')
  } finally {
    els.save.disabled = false
  }
}

async function importLinkValue(value) {
  const link = String(value || '').trim()
  if (!link) {
    banner('请先粘贴 vless:// 链接或从二维码导入', 'error')
    return false
  }
  const result = await send({ type: 'import-link', link })
  if (!result?.ok) {
    const message = result?.errors?.[0]?.message || result?.error || '导入失败'
    banner(message, 'error')
    setScanStatus(message, 'error')
    return false
  }
  formDirty = false
  render(result.state, { forceForm: true })
  banner('')
  setScanStatus(`已导入节点：${result.state.config.profile.name || '未命名'}`, 'ok')
  invalidateGenerated()
  return true
}

function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function safeFileStem(text) {
  return String(text || 'node')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'node'
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text)
    setScanStatus(okMessage || '已复制', 'ok')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    setScanStatus(okMessage || '已复制', 'ok')
  }
}

// ---------------------------------------------------------------------------
// QR decoding
// ---------------------------------------------------------------------------

async function decodeCanvas(canvas) {
  if ('BarcodeDetector' in window) {
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const codes = await detector.detect(canvas)
      if (codes && codes.length > 0 && codes[0].rawValue) return codes[0].rawValue
    } catch {
      // fall through to jsQR
    }
  }
  if (typeof window.jsQR === 'function') {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
    if (code && code.data) return code.data
  }
  return null
}

async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return decodeCanvas(canvas)
}

async function acceptScannedText(text, source) {
  const value = String(text || '').trim()
  if (!value) {
    setScanStatus('没有识别到二维码内容', 'error')
    return
  }
  els.shareLink.value = value
  formDirty = true
  if (!/^vless:\/\//i.test(value)) {
    setScanStatus(`识别到${source}内容，但不是 vless:// 链接：${value.slice(0, 48)}`, 'error')
    return
  }
  setScanStatus(`已从${source}识别链接，正在导入…`)
  await importLinkValue(value)
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setScanStatus('当前环境不支持摄像头；请使用二维码图片导入', 'error')
    return
  }
  if (cameraStream) return
  setScanStatus('正在请求摄像头权限…')
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    els.video.srcObject = cameraStream
    els.video.hidden = false
    await els.video.play()
    els.cameraStart.hidden = true
    els.cameraStop.hidden = false
    setScanStatus('请把二维码对准摄像头…')
    cameraTimer = setInterval(async () => {
      if (!cameraStream || els.video.readyState < 2) return
      const canvas = document.createElement('canvas')
      canvas.width = els.video.videoWidth
      canvas.height = els.video.videoHeight
      if (!canvas.width || !canvas.height) return
      canvas.getContext('2d').drawImage(els.video, 0, 0)
      try {
        const text = await decodeCanvas(canvas)
        if (text) {
          await stopCamera()
          await acceptScannedText(text, '摄像头')
        }
      } catch {
        // a frame that fails to decode is normal; keep scanning
      }
    }, 400)
  } catch (error) {
    cameraStream = null
    const name = error?.name
    const hint =
      name === 'NotAllowedError'
        ? '摄像头权限被拒绝：点击地址栏左侧的权限图标允许摄像头，或改用二维码图片导入'
        : name === 'NotFoundError'
          ? '没有找到摄像头：请改用二维码图片导入'
          : name === 'NotReadableError'
            ? '摄像头被其他程序占用：关闭占用程序后重试，或改用二维码图片导入'
            : `摄像头未启动：${String(error?.message ?? error)}；可改用二维码图片`
    setScanStatus(hint, 'error')
  }
}

async function stopCamera() {
  if (cameraTimer) {
    clearInterval(cameraTimer)
    cameraTimer = null
  }
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop()
    cameraStream = null
  }
  els.video.srcObject = null
  els.video.hidden = true
  els.cameraStart.hidden = false
  els.cameraStop.hidden = true
}

// ---------------------------------------------------------------------------
// Config generation / data
// ---------------------------------------------------------------------------

function generateConfig() {
  if (!state?.config?.profile?.node) {
    banner('请先导入 VLESS 节点，再生成 Xray 配置', 'error')
    return
  }
  try {
    generated = buildXrayConfigFromConfig(state.config)
    const text = JSON.stringify(generated, null, 2)
    els.configPreview.textContent = text
    els.configPreview.hidden = false
    els.configTag.textContent = `inbound ${generated.inbounds[0].listen}:${generated.inbounds[0].port}`
    const mode = state.config.routing.mode
    const extra = mode === 'cn-direct' ? '；cn-direct 规则需要 geosite.dat / geoip.dat' : ''
    els.configHint.textContent = `已生成 ${new Blob([text]).size} 字节；保存为 config.json 后执行下方命令${extra}。`
    banner('')
  } catch (error) {
    banner(`生成失败：${String(error?.message ?? error)}`, 'error')
  }
}

function exportSettings() {
  if (!state) return
  const payload = {
    kind: '2xray-chrome-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: {
      proxy: state.config.proxy,
      routing: state.config.routing,
      probe: state.config.probe,
      profile: { shareLink: state.config.profile.shareLink },
    },
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  downloadText(`2xray-settings-${stamp}.json`, JSON.stringify(payload, null, 2))
  banner('设置已导出（包含节点密钥，请妥善保管）', 'warn')
}

async function importSettingsFile(file) {
  let payload
  try {
    payload = JSON.parse(await file.text())
  } catch (error) {
    banner(`导入失败：不是合法 JSON（${String(error?.message ?? error)}）`, 'error')
    return
  }
  const config = payload?.config ?? payload
  if (!config || typeof config !== 'object') {
    banner('导入失败：文件里没有 config 对象', 'error')
    return
  }
  const patch = {}
  if (config.proxy) patch.proxy = config.proxy
  if (config.routing) patch.routing = config.routing
  if (config.probe) patch.probe = config.probe
  const result = await send({ type: 'save-config', patch })
  if (!result?.ok) {
    banner(result?.errors?.[0]?.message || result?.error || '导入失败', 'error')
    return
  }
  formDirty = false
  render(result.state, { forceForm: true })
  if (config.profile?.shareLink) {
    await importLinkValue(config.profile.shareLink)
  }
  banner('设置已导入')
  invalidateGenerated()
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

for (const id of FORM_IDS) {
  const element = $(id)
  element.addEventListener('input', () => {
    formDirty = true
    setSaveState('', '未保存')
    if (id === 'proxy-protocol' || id === 'proxy-host' || id === 'proxy-port') updateEndpointPreview()
  })
}

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', () => {
    formDirty = true
    setSaveState('', '未保存')
  })
})

els.save.addEventListener('click', save)
els.importLink.addEventListener('click', async () => {
  els.importLink.disabled = true
  try {
    await importLinkValue(els.shareLink.value)
  } finally {
    els.importLink.disabled = false
  }
})

els.clearLink.addEventListener('click', async () => {
  if (!confirm('清空当前 VLESS 节点？代理设置不会自动关闭。')) return
  const result = await send({ type: 'clear-profile' })
  if (result?.state) {
    formDirty = false
    render(result.state, { forceForm: true })
  }
  banner(result?.ok === false ? result?.errors?.[0]?.message || '清空失败' : '')
  setScanStatus(result?.ok === false ? '清空失败' : '已清空节点', result?.ok === false ? 'error' : 'ok')
  invalidateGenerated()
})

els.copyLink.addEventListener('click', async () => {
  if (!state?.profileLink) {
    banner('当前没有可复制的 VLESS 链接', 'error')
    return
  }
  await copyText(state.profileLink, 'VLESS 链接已复制')
})

els.qrFile.addEventListener('change', async () => {
  const file = els.qrFile.files?.[0]
  if (!file) return
  setScanStatus('正在识别图片…')
  try {
    const text = await decodeImageFile(file)
    if (!text) {
      setScanStatus('图片里没有识别到二维码；换一张更清晰、更大的图片', 'error')
      return
    }
    await acceptScannedText(text, '图片')
  } catch (error) {
    setScanStatus(`识别失败：${String(error?.message ?? error)}`, 'error')
  } finally {
    els.qrFile.value = ''
  }
})

els.cameraStart.addEventListener('click', startCamera)
els.cameraStop.addEventListener('click', stopCamera)

els.generateConfig.addEventListener('click', generateConfig)
els.downloadConfig.addEventListener('click', () => {
  if (!state?.config?.profile?.node) {
    banner('请先导入 VLESS 节点', 'error')
    return
  }
  if (!generated) generateConfig()
  if (!generated) return
  const stem = safeFileStem(state.config.profile.name)
  downloadText(`2xray-${stem}.json`, JSON.stringify(generated, null, 2))
})
els.copyConfig.addEventListener('click', async () => {
  if (!state?.config?.profile?.node) {
    banner('请先导入 VLESS 节点', 'error')
    return
  }
  if (!generated) generateConfig()
  if (!generated) return
  await copyText(JSON.stringify(generated, null, 2), 'Xray 配置已复制')
})

els.exportSettings.addEventListener('click', exportSettings)
els.importSettings.addEventListener('change', async () => {
  const file = els.importSettings.files?.[0]
  if (!file) return
  try {
    await importSettingsFile(file)
  } catch (error) {
    banner(`导入失败：${String(error?.message ?? error)}`, 'error')
  } finally {
    els.importSettings.value = ''
  }
})

els.reset.addEventListener('click', async () => {
  if (!confirm('恢复默认设置并关闭代理？节点与日志也会清空。')) return
  const result = await send({ type: 'reset' })
  if (result?.state) {
    formDirty = false
    render(result.state, { forceForm: true })
  }
  banner('已恢复默认设置')
  setScanStatus('')
  invalidateGenerated()
})

window.addEventListener('pagehide', () => {
  void stopCamera()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes.config && !changes.runtime) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => refresh({ forceForm: !formDirty }), 180)
})

refresh({ forceForm: true })
