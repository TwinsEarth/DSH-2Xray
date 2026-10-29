window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-2xray',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'xray'
    const NS = 'xray-proxy'
    const inject = ['slots']
    const BROWSER_HINT =
      '内置浏览器走 Chromium 网络栈，不受插件 dispatcher 影响：请用插件目录 tools/launch-with-browser-proxy.cmd 启动 DSH，或在快捷方式目标后追加 --proxy-server=http://127.0.0.1:20808（需完全退出 DSH 后重启才生效）。'

    const C = {
      page: { maxWidth: 980, margin: '0 auto', padding: '20px 24px 16px', color: 'var(--dsw-alias-label-primary, #0f1115)' },
      header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 },
      globe: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #61666b)', margin: '2px 0 0' },
      pill: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))' },
      dot: { width: 8, height: 8, borderRadius: 999, background: '#9ca3af' },
      card: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 12, padding: 12, marginBottom: 12, background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, fontWeight: 600 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #61666b)', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))' },
      td: { padding: '7px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))', verticalAlign: 'middle' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
      logBox: { height: 220, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 8, padding: '6px 8px', background: 'var(--dsw-alias-markdown-code-block, #f9fafb)' },
      logLine: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: '18px', fontFamily: 'ui-monospace, Consolas, monospace' },
      statusBar: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 12, padding: '10px 14px', fontSize: 12.5 },
      btn: { padding: '5px 10px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      primaryBtn: { padding: '6px 12px', borderRadius: 7, border: '1px solid #2563eb', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 12.5 },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))', background: 'transparent', color: 'inherit', fontSize: 12.5 },
      label: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #61666b)', margin: '8px 0 4px' },
      muted: { color: 'var(--dsw-alias-label-secondary, #61666b)' },
      error: { color: '#c81e1e' },
    }

    function GlobeIcon({ size = 20 } = {}) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9 }),
        h('path', { d: 'M3 12h18M4.5 7.5h15M4.5 16.5h15' }),
      )
    }

    function phaseOf(status) {
      if (!status) return { label: '状态未知', color: '#9ca3af' }
      if (status.proxied) return { label: '已连接', color: '#15803d' }
      if (status.state === 'ready') return { label: '已就绪 · 未接管', color: '#b45309' }
      if (status.state === 'degraded') return { label: '连接降级', color: '#b45309' }
      if (status.state === 'starting' || status.state === 'resolving' || status.state === 'backoff') return { label: '正在连接', color: '#2f5fbf' }
      if (status.state === 'failed') return { label: '连接失败', color: '#c81e1e' }
      if (status.state === 'stopped') return { label: '已停止', color: '#9ca3af' }
      return { label: '未启用', color: '#9ca3af' }
    }

    function fmtTime(ts) {
      const d = new Date(ts)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    }

    function StatusPill({ status }) {
      const phase = phaseOf(status)
      return h('span', { style: C.pill }, h('span', { style: { ...C.dot, background: phase.color } }), phase.label)
    }

    function useStatusFeed() {
      const [status, setStatus] = React.useState(null)
      const [logs, setLogs] = React.useState([])
      const [error, setError] = React.useState(null)
      const cursor = React.useRef(0)

      React.useEffect(() => {
        let cancelled = false
        let timer
        const tick = async () => {
          try {
            const url = new URL(`api/xray/status?after=${cursor.current}`, document.baseURI)
            const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (cancelled) return
            setStatus(data.status)
            if (Array.isArray(data.logs) && data.logs.length > 0) {
              setLogs((previous) => {
                const merged = previous.concat(data.logs)
                return merged.length > 500 ? merged.slice(merged.length - 500) : merged
              })
            }
            cursor.current = data.cursor ?? cursor.current
            setError(null)
          } catch (cause) {
            if (!cancelled) setError(cause.message || String(cause))
          }
          if (!cancelled) timer = setTimeout(tick, 2000)
        }
        tick()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [])

      return { status, logs, error, setLogs }
    }

    function fmtUptime(seconds) {
      const total = Math.max(0, Math.floor(seconds ?? 0))
      const hh = Math.floor(total / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    }

    function ConfigCard({ status }) {
      const nodes = status?.nodes ?? []
      const active = nodes.find((node) => node.tag === status?.activeNode) ?? nodes[0]
      const [switching, setSwitching] = React.useState(false)
      const [message, setMessage] = React.useState('')

      if (nodes.length === 0) {
        return h('section', { style: C.card },
          h('div', { style: C.cardHead }, '① 当前 VPN 配置'),
          h('div', { style: { ...C.muted, fontSize: 12.5 } }, '还没有节点。到「设置 → 插件 → Xray 代理」粘贴 vless 链接并保存，重启 DSH 后这里会显示。'))
      }

      const switchTo = async (tag) => {
        if (!tag || tag === status?.activeNode) return
        setSwitching(true)
        setMessage('')
        try {
          const response = await fetch(new URL('api/xray/switch', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ node: tag }),
          })
          const data = await response.json()
          if (!data.ok) throw new Error(data.error || '切换失败')
          setMessage(`已切换到 ${tag}`)
        } catch (error) {
          setMessage(String(error.message || error))
        } finally {
          setSwitching(false)
        }
      }

      return h('section', { style: C.card },
        h('div', { style: C.cardHead }, '① 当前 VPN 配置',
          h('span', { style: { ...C.muted, fontWeight: 400, marginLeft: 'auto' } }, `${nodes.length} 个节点`)),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('select', {
            value: active?.tag ?? '',
            disabled: switching,
            onChange: (event) => switchTo(event.target.value),
            style: { ...C.input, width: 'auto', minWidth: 180 },
          }, nodes.map((node) => h('option', { key: node.tag, value: node.tag }, node.id ?? node.tag))),
          h('span', { style: { ...C.mono, fontSize: 12.5 } }, active ? `VLESS · ${active.address}:${active.port}` : '—'),
          h('span', { style: { ...C.muted, fontSize: 12 } }, switching ? '切换中…' : message)),
        active
          ? h('div', { style: { ...C.muted, fontSize: 12.5, marginTop: 8 } },
              `安全：${String(active.security || 'none').toUpperCase()}${active.serverName ? ` (${active.serverName})` : ''} · 传输：${active.network || 'raw'}${active.flow ? ` · flow：${active.flow}` : ''}`)
          : null)
    }

    function RuntimeCard({ status, logs, setLogs }) {
      const [showLogs, setShowLogs] = React.useState(true)
      const inbound = status?.inbound
      const inboundLabel = inbound
        ? `${String(inbound.protocol).toUpperCase()}:${inbound.port}${inbound.socks ? ` · SOCKS5:${inbound.socks.port}` : ''}`
        : '—'
      const metrics = [
        ['运行时长', fmtUptime(status?.uptimeSec)],
        ['代理端口', status ? `:${status.port}` : '—'],
        ['Xray PID', status?.process?.pid ?? '—'],
        ['入站类型', inboundLabel],
      ]
      return h('section', { style: C.card },
        h('div', { style: C.cardHead }, '② 实时连接信息',
          h('button', { type: 'button', style: { ...C.btn, marginLeft: 'auto' }, onClick: () => setShowLogs((value) => !value) },
            showLogs ? '收起日志' : '查看日志')),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 } },
          metrics.map(([label, value]) => h('div', { key: label },
            h('div', { style: { ...C.muted, fontSize: 11.5 } }, label),
            h('div', { style: { ...C.mono, fontSize: 14, fontWeight: 600, marginTop: 2 } }, String(value))))),
        showLogs ? h('div', { style: { marginTop: 12 } }, h(LogList, { logs, setLogs })) : null)
    }

    function StatusCard({ status, latency, egress, phase }) {
      const routingLabel =
        { global: '全局', 'cn-direct': '国内直连', whitelist: '白名单' }[status?.routing?.mode] ?? '全局'
      return h('section', { style: C.card },
        h('div', { style: C.cardHead }, '③ 连接状态'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { ...C.dot, background: phase.color } }),
          h('b', { style: { fontSize: 14 } }, phase.label),
          h('span', { style: { ...C.mono, fontSize: 13 } }, latency == null ? '延迟 —' : `延迟 ${latency} ms`),
          h('span', { style: { ...C.mono, fontSize: 12.5, marginLeft: 'auto' } },
            egress?.ip ? `出口 IP ${egress.ip}${egress.country ? ` (${egress.country})` : ''}` : '出口 IP —')),
        h('div', { style: { ...C.muted, fontSize: 12.5, marginTop: 6 } },
          `节点「${status?.vpnName ?? status?.activeNode ?? '—'}」` +
            ` · 路由：${routingLabel}` +
            (status?.routingFallback ? '（geodata 缺失，已降级全局）' : '') +
            (status?.route?.installed ? ` · ${status.route.mode === 'harness' ? 'DSH 策略已接管' : '内置 dispatcher'}` : ' · 尚未接管')))
    }

    function LogList({ logs, setLogs }) {
      const box = React.useRef(null)
      const [follow, setFollow] = React.useState(true)
      React.useEffect(() => {
        if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
      }, [logs, follow])
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 6 } },
          h('button', { type: 'button', style: C.btn, onClick: () => setFollow((v) => !v) }, follow ? '自动滚动：开' : '自动滚动：关'),
          h('button', { type: 'button', style: C.btn, onClick: () => setLogs([]) }, '清空视图')),
        h('div', { ref: box, style: C.logBox },
          logs.length === 0
            ? h('div', { style: { ...C.muted, fontSize: 12 } }, '暂无连接日志')
            : logs.map((line) => h('div', { key: line.seq, style: C.logLine },
                h('span', { style: { ...C.muted, flex: '0 0 66px' } }, fmtTime(line.ts)),
                h('span', { style: { flex: '0 0 40px', color: line.level === 'error' ? '#c81e1e' : line.level === 'warn' ? '#b45309' : 'inherit' } }, line.level.toUpperCase()),
                h('span', { style: { flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, line.text)))))
    }

    function XrayPage() {
      const { status, logs, error, setLogs } = useStatusFeed()
      const phase = phaseOf(status)
      const probe = status?.probe ?? {}
      const latency = probe.latency?.ms
      const egress = probe.egress ?? {}
      const localEndpoint = status ? `127.0.0.1:${status.port}` : '—'
      const routingLabel =
        { global: '全局代理', 'cn-direct': '国内直连', whitelist: '白名单代理' }[status?.routing?.mode] ?? '全局代理'
      const fallbackNote = status?.routingFallback ? ' · geodata 缺失，已降级全局' : ''

      return h('div', { style: C.page },
        h('div', { style: C.header },
          h('span', { style: C.globe }, h(GlobeIcon, { size: 22 })),
          h('div', null,
            h('h1', { style: C.title }, '2Xray'),
            h('p', { style: C.sub }, `Xray ${routingLabel} · 本地 ${localEndpoint}${fallbackNote}`)),
          h(StatusPill, { status })),
        error
          ? h('div', { style: { ...C.card, ...C.error, fontSize: 12.5 } }, `状态通道不可用：${error}（代理本身可能仍在工作）`)
          : null,
        status?.reason && status.state !== 'ready'
          ? h('div', { style: { ...C.card, fontSize: 12.5 } }, h('b', null, '原因：'), ` ${status.reason}`,
              status.detail ? h('div', { style: { ...C.muted, marginTop: 4 } }, status.detail) : null)
          : null,
        h(ConfigCard, { status }),
        h(RuntimeCard, { status, logs, setLogs }),
        h(StatusCard, { status, latency, egress, phase }))
    }

    function Field({ label, children }) {
      return h('div', null, h('label', { style: C.label }, label), children)
    }

    function controllerValue(controller) {
      try {
        const snapshot = controller?.getSnapshot?.()
        return snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {}
      } catch {
        return {}
      }
    }

    function pageValue(pageForm) {
      const value = pageForm?.state?.value
      return value && typeof value === 'object' ? value : {}
    }

    async function writeFields({ pageForm, controller }, fields) {
      if (pageForm && typeof pageForm.mutate === 'function') {
        const ops = fields.map(({ path, value }) => ({ op: 'set', path, value }))
        const accepted = await pageForm.mutate(ops, pageForm.state?.revision)
        if (accepted === false) throw new Error('写入被拒绝（revision 冲突）')
        return
      }
      if (controller && typeof controller.mutate === 'function') {
        for (const { path, value } of fields) {
          if (path.length === 1 && typeof controller.set === 'function') {
            const accepted = await controller.set(path[0], value)
            if (accepted === false) throw new Error('写入被拒绝（revision 冲突）')
          } else {
            const revision = controller.getSnapshot?.()?.revision
            const accepted = await controller.mutate([{ op: 'set', path, value }], revision)
            if (accepted === false) throw new Error('写入被拒绝（revision 冲突）')
          }
        }
        return
      }
      throw new Error('设置表单不可写')
    }

    async function decodeQrFromCanvas(canvas) {
      if (!('BarcodeDetector' in window)) return null
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const codes = await detector.detect(canvas)
      return codes && codes.length > 0 ? codes[0].rawValue : null
    }

    function XrayConfigForm({ controller, pageForm }) {
      const value = controller ? controllerValue(controller) : pageValue(pageForm)
      const [shareLink, setShareLink] = React.useState(value.shareLink ?? '')
      const [binaryPath, setBinaryPath] = React.useState(value.binary?.path ?? '')
      const [port, setPort] = React.useState(String(value.inbound?.port ?? 20808))
      const [enabled, setEnabled] = React.useState(value.enabled === true)
      const [takeover, setTakeover] = React.useState(value.takeover ?? 'auto')
      const [routingMode, setRoutingMode] = React.useState(value.routing?.mode ?? 'global')
      const [whitelist, setWhitelist] = React.useState((value.routing?.whitelist ?? []).join('\n'))
      const [blacklist, setBlacklist] = React.useState((value.routing?.blacklist ?? []).join('\n'))
      const [autoUpdate, setAutoUpdate] = React.useState(value.updates?.auto === true)
      const [updateInfo, setUpdateInfo] = React.useState(null)
      const [updateBusy, setUpdateBusy] = React.useState('')
      const [autoGeodata, setAutoGeodata] = React.useState(value.geodata?.autoUpdate !== false)
      const [message, setMessage] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [scanning, setScanning] = React.useState(false)
      const videoRef = React.useRef(null)
      const streamRef = React.useRef(null)
      const timerRef = React.useRef(null)

      const say = (text, tone) => {
        setMessage(text)
        setKind(tone || '')
      }

      const loadUpdate = async (refresh = false) => {
        try {
          const response = await fetch(new URL(`api/xray/update${refresh ? '?refresh=1' : ''}`, document.baseURI), {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          const data = await response.json()
          if (data.update) setUpdateInfo(data.update)
          return data
        } catch (error) {
          say('检查更新失败：' + (error.message || error), 'error')
          return null
        }
      }

      const installNow = async () => {
        setUpdateBusy('install')
        try {
          const response = await fetch(new URL('api/xray/update', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'install' }),
          })
          const data = await response.json()
          if (data.update) setUpdateInfo(data.update)
          const detail = data.error || data.result?.error || (data.result?.stage ? `阶段 ${data.result.stage}` : '未知错误')
          say(
            data.ok ? `已下载 ${data.update?.latest ?? '新版本'}，重启 DSH 后生效。` : '更新失败：' + detail,
            data.ok ? 'ok' : 'error',
          )
        } catch (error) {
          say('更新失败：' + (error.message || error), 'error')
        } finally {
          setUpdateBusy('')
        }
      }

      React.useEffect(() => {
        loadUpdate(false)
      }, [])

      const applyDecoded = (text) => {
        const trimmed = String(text || '').trim()
        if (!trimmed) return
        setShareLink(trimmed)
        say('已识别二维码，确认后点保存。', 'ok')
      }

      const onFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        say('正在解析图片…')
        try {
          const bitmap = await createImageBitmap(file)
          const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(bitmap.width * scale))
          canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const decoded = await decodeQrFromCanvas(canvas)
          if (!decoded) say('没有识别到二维码；当前浏览器不支持或图片不清晰，可改用插件目录 tools/scanner.html。', 'error')
          else applyDecoded(decoded)
        } catch (error) {
          say('解析失败：' + (error.message || error), 'error')
        }
      }

      const stopScan = () => {
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = null
        if (streamRef.current) for (const track of streamRef.current.getTracks()) track.stop()
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        setScanning(false)
      }

      const tick = async () => {
        const video = videoRef.current
        if (!video || !streamRef.current || video.readyState < 2 || !video.videoWidth) return
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        try {
          const decoded = await decodeQrFromCanvas(canvas)
          if (decoded) {
            applyDecoded(decoded)
            stopScan()
          }
        } catch {
          // a frame without a readable code is normal
        }
      }

      const startScan = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          say('当前浏览器不支持屏幕捕获；请使用「二维码图片」。', 'error')
          return
        }
        if (!('BarcodeDetector' in window)) {
          say('当前浏览器没有 BarcodeDetector；请使用插件目录 tools/scanner.html（内置 jsQR）。', 'error')
          return
        }
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false })
          streamRef.current = stream
          setScanning(true)
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            videoRef.current.style.display = 'block'
            await videoRef.current.play()
          }
          stream.getVideoTracks()[0].addEventListener('ended', stopScan)
          timerRef.current = setInterval(tick, 350)
          say('请把二维码放到共享屏幕上…')
        } catch (error) {
          say('屏幕共享未开始：' + (error.message || error), 'error')
          setScanning(false)
        }
      }

      React.useEffect(() => () => stopScan(), [])

      const save = async () => {
        setBusy(true)
        try {
          const splitList = (text) =>
            String(text)
              .split(/[\n,]+/)
              .map((entry) => entry.trim())
              .filter(Boolean)
          const fields = [
            { path: ['shareLink'], value: shareLink.trim() },
            { path: ['enabled'], value: enabled },
            { path: ['takeover'], value: takeover },
            { path: ['routing', 'mode'], value: routingMode },
            { path: ['routing', 'whitelist'], value: splitList(whitelist) },
            { path: ['routing', 'blacklist'], value: splitList(blacklist) },
            { path: ['updates', 'auto'], value: autoUpdate },
            { path: ['geodata', 'autoUpdate'], value: autoGeodata },
          ]
          if (binaryPath.trim()) fields.push({ path: ['binary', 'path'], value: binaryPath.trim() })
          const numericPort = Number(port)
          if (Number.isInteger(numericPort) && numericPort > 0) fields.push({ path: ['inbound', 'port'], value: numericPort })
          await writeFields({ controller, pageForm }, fields)
          say('已保存。重启 DSH 后生效。', 'ok')
        } catch (error) {
          say('保存失败：' + (error.message || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      return h('div', null,
        h(Field, { label: '1. VLESS 分享链接（粘贴）' },
          h('textarea', {
            style: { ...C.input, minHeight: 64, fontFamily: 'ui-monospace, Consolas, monospace' },
            value: shareLink,
            placeholder: 'vless://uuid@host:443?security=reality&sni=...&pbk=...#备注',
            onChange: (event) => setShareLink(event.target.value),
          })),
        h(Field, { label: '2. 本地二维码图片' },
          h('input', { type: 'file', accept: 'image/*', onChange: onFile, disabled: scanning })),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: C.btn, onClick: startScan, disabled: scanning }, scanning ? '扫描中…' : '扫描屏幕二维码'),
          h('button', { type: 'button', style: C.btn, onClick: stopScan, disabled: !scanning }, '停止'),
          h('span', { style: { ...C.muted, fontSize: 12 } }, '本地图片/屏幕扫码结果会填入上方链接')),
        h('video', { ref: videoRef, playsInline: true, muted: true, style: { ...C.input, display: 'none', maxHeight: 240, background: '#000' } }),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }), '启用代理'),
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 } }, 'takeover',
            h('select', { value: takeover, onChange: (event) => setTakeover(event.target.value), style: { padding: '4px 8px', borderRadius: 6, background: 'transparent', color: 'inherit' } },
              h('option', { value: 'auto' }, 'auto'), h('option', { value: 'force' }, 'force'), h('option', { value: 'off' }, 'off')))),
        h(Field, { label: '路由模式' },
          h('select', {
            value: routingMode,
            onChange: (event) => setRoutingMode(event.target.value),
            style: { ...C.input, width: 'auto' },
          },
            h('option', { value: 'global' }, '全局：全部走 2Xray'),
            h('option', { value: 'cn-direct' }, '国内直连：国内 IP/域名不走 VPN，国外走'),
            h('option', { value: 'whitelist' }, '白名单：仅白名单走 2Xray'))),
        h(Field, { label: '白名单（强制走 2Xray，每行一个域名）' },
          h('textarea', {
            style: { ...C.input, minHeight: 58, fontFamily: 'ui-monospace, Consolas, monospace' },
            value: whitelist,
            placeholder: 'github.com\ngoogle.com\nyoutube.com\nx.com\nfacebook.com',
            onChange: (event) => setWhitelist(event.target.value),
          })),
        h(Field, { label: '黑名单（强制直连，每行一个域名，优先于白名单）' },
          h('textarea', {
            style: { ...C.input, minHeight: 58, fontFamily: 'ui-monospace, Consolas, monospace' },
            value: blacklist,
            placeholder: 'deepseek.com\napi.deepseek.com',
            onChange: (event) => setBlacklist(event.target.value),
          })),
        h('div', { style: { ...C.cardHead, marginTop: 14 } }, '更新'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', {
            type: 'button',
            style: C.btn,
            onClick: () => loadUpdate(true),
          }, '检测更新'),
          h('button', {
            type: 'button',
            style: C.primaryBtn,
            disabled: updateBusy === 'install' || !updateInfo?.available,
            onClick: installNow,
          }, updateBusy === 'install' ? '更新中…' : '立即更新'),
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', { type: 'checkbox', checked: autoUpdate, onChange: (event) => setAutoUpdate(event.target.checked) }), '自动更新'),
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', { type: 'checkbox', checked: autoGeodata, onChange: (event) => setAutoGeodata(event.target.checked) }), '每 72 小时更新规则数据')),
        h('div', { style: { ...C.muted, fontSize: 12, marginTop: 6 } },
          updateInfo
            ? `当前 ${updateInfo.current} · 最新 ${updateInfo.latest ?? '未知'}${updateInfo.available ? '（可更新）' : '（已是最新）'}` +
              (updateInfo.restartRequired ? ' · 已下载，重启 DSH 生效' : '')
            : '点击「检测更新」查询 npm 上的最新版本'),
        h(Field, { label: 'xray 可执行文件路径（留空自动查找）' },
          h('input', { style: { ...C.input, fontFamily: 'ui-monospace, Consolas, monospace' }, value: binaryPath, placeholder: '例如 D:\\v2rayN\\...\\bin\\xray\\xray.exe', onChange: (event) => setBinaryPath(event.target.value) })),
        h(Field, { label: '本地 HTTP 入站端口' },
          h('input', { style: C.input, value: port, onChange: (event) => setPort(event.target.value) })),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 } },
          h('button', { type: 'button', style: C.primaryBtn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('span', { style: { fontSize: 12, color: kind === 'error' ? '#c81e1e' : kind === 'ok' ? '#15803d' : undefined } }, message)),
        h('p', { style: { ...C.muted, fontSize: 12, marginTop: 10 } }, '保存后重启 DSH；左侧「2Xray」面板显示节点、日志、延迟与出口 IP。'))
    }

    function XraySettingsCard({ view, form }) {
      if (view === 'summary') {
        return h('div', { style: { ...C.muted, fontSize: 12.5 } }, 'VLESS 链接 / 本地二维码导入 · 保存后重启 DSH 生效')
      }
      return h('div', { style: { ...C.card, marginTop: 8 } },
        h('div', { style: C.cardHead }, h(GlobeIcon), '2Xray 连接'),
        h(XrayConfigForm, { pageForm: form }),
        h('p', { style: { ...C.muted, fontSize: 12, marginTop: 10 } }, BROWSER_HINT))
    }

    function SettingsSection({ controller }) {
      return h('div', { style: C.page },
        h('div', { style: C.header },
          h('span', { style: C.globe }, h(GlobeIcon, { size: 22 })),
          h('div', null,
            h('h1', { style: C.title }, '2Xray'),
            h('p', { style: C.sub }, '导入 VLESS 链接或本地二维码，保存后重启 DSH 生效。'))),
        h('section', { style: C.card }, h(XrayConfigForm, { controller })),
        h('p', { style: { ...C.muted, fontSize: 12, marginTop: 4 } }, BROWSER_HINT))
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: () => '2Xray' }, GlobeIcon),
          ),
        'dsh-2xray: sidebar entry',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, XrayPage),
          ),
        'dsh-2xray: main panel',
      )
      if (typeof ctx.inject === 'function') {
        ctx.inject(['configForms'], (child) => {
          try {
            // A dedicated Settings tab. It owns the ConfigFormController, so the
            // full editor works even when the plugins page passes a narrow form.
            const controller = child.configForms.get(NS)
            child.effect(
              () =>
                child.slots.inject('settings.section', () =>
                  child.slots.register(
                    { name: 'settings.section', id: NS, order: 30, label: () => '2Xray' },
                    () => h(SettingsSection, { controller }),
                  ),
                ),
              'dsh-2xray: settings section',
            )
            // The plugins page card: its id MUST equal the settings namespace,
            // otherwise the page's formFor(id) returns undefined.
            child.effect(
              () =>
                child.configForms.whileServed([NS], () =>
                  child.slots.inject('plugins.item', () =>
                    child.slots.register({ name: 'plugins.item', id: NS, order: 40, label: () => '2Xray' }, XraySettingsCard),
                  ),
                ),
              'dsh-2xray: plugins card',
            )
          } catch (error) {
            console.error('[dsh-2xray] client registration failed', error)
          }
        })
      }
    }

    return { apply, inject, PANEL_ID, NS }
  },
})
