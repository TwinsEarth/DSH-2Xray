window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-2xray',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'xray'
    const inject = ['slots', 'locale']

    function GlobeIcon() {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
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

    const styles = {
      page: { maxWidth: 760, margin: '0 auto', padding: '28px 20px 48px', color: 'var(--dsh-text, #e2e8f0)' },
      title: { fontSize: 20, fontWeight: 600, margin: '0 0 4px' },
      hint: { color: 'var(--dsh-text-secondary, #94a3b8)', fontSize: 13, margin: '0 0 20px' },
      card: { border: '1px solid var(--dsh-border, #334155)', borderRadius: 12, padding: 16, marginBottom: 16 },
      h2: { fontSize: 15, margin: '0 0 10px' },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 84,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--dsh-border, #334155)',
        background: 'var(--dsh-surface, #0b1220)',
        color: 'inherit',
        font: '13px/1.5 ui-monospace, Consolas, monospace',
        resize: 'vertical',
      },
      row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 },
      button: {
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border, #334155)',
        background: 'var(--dsh-surface-raised, #334155)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 14,
      },
      primary: { background: '#2563eb', borderColor: '#2563eb', color: '#fff' },
      status: { fontSize: 13, marginTop: 10, minHeight: 20, color: 'var(--dsh-text-secondary, #94a3b8)' },
      video: { width: '100%', maxHeight: 320, borderRadius: 8, background: '#000', marginTop: 12, display: 'none' },
      steps: { margin: '10px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--dsh-text-secondary, #94a3b8)' },
    }

    function XrayPage() {
      const [text, setText] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [statusKind, setStatusKind] = React.useState('')
      const [scanning, setScanning] = React.useState(false)
      const videoRef = React.useRef(null)
      const streamRef = React.useRef(null)
      const timerRef = React.useRef(null)
      const detectorRef = React.useRef(null)

      const say = (message, kind) => {
        setStatus(message)
        setStatusKind(kind || '')
      }

      const detector = () => {
        if (detectorRef.current !== null) return detectorRef.current
        detectorRef.current = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : false
        return detectorRef.current
      }

      const decodeCanvas = async (canvas) => {
        const det = detector()
        if (!det) return null
        const codes = await det.detect(canvas)
        return codes && codes.length > 0 ? codes[0].rawValue : null
      }

      const accept = (value) => {
        const trimmed = String(value || '').trim()
        if (!trimmed) return false
        setText(trimmed)
        say('已识别：' + trimmed.slice(0, 64) + (trimmed.length > 64 ? '…' : ''), 'ok')
        return true
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
          const value = await decodeCanvas(canvas)
          if (!value) say('图片里没有识别到二维码；换一张更清晰/更大的图，或使用插件目录里的 tools/scanner.html（带 jsQR 兜底）。', 'error')
          else accept(value)
        } catch (error) {
          say('解析失败：' + error.message, 'error')
        }
      }

      const stop = async () => {
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) track.stop()
          streamRef.current = null
        }
        if (videoRef.current) videoRef.current.srcObject = null
        setScanning(false)
      }

      const tick = async () => {
        const video = videoRef.current
        if (!video || !streamRef.current) return
        if (video.readyState < 2 || !video.videoWidth) return
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        try {
          const value = await decodeCanvas(canvas)
          if (value) {
            accept(value)
            await stop()
            say('已识别并停止扫描。', 'ok')
          }
        } catch {
          // a failed frame is normal while the code is out of view
        }
      }

      const startScreen = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          say('当前浏览器不支持屏幕捕获；请改用「二维码图片」或 tools/scanner.html。', 'error')
          return
        }
        if (!detector()) {
          say('当前浏览器没有 BarcodeDetector；请使用插件目录里的 tools/scanner.html（内置 jsQR 兜底）。', 'error')
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
          stream.getVideoTracks()[0].addEventListener('ended', stop)
          say('请把二维码放到共享屏幕上，正在识别…')
          timerRef.current = setInterval(tick, 350)
        } catch (error) {
          say('屏幕共享未开始：' + error.message, 'error')
          setScanning(false)
        }
      }

      React.useEffect(() => () => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (streamRef.current) for (const track of streamRef.current.getTracks()) track.stop()
      }, [])

      const copy = async () => {
        if (!text.trim()) {
          say('还没有链接可复制。', 'error')
          return
        }
        try {
          await navigator.clipboard.writeText(text.trim())
          say('已复制。粘贴到「插件 → Xray 代理 → 分享链接」后保存，并重启 DSH。', 'ok')
        } catch {
          say('复制失败，请手动选中文本复制。', 'error')
        }
      }

      return h(
        'div',
        { style: styles.page },
        h('h1', { style: styles.title }, '2Xray'),
        h('p', { style: styles.hint }, '扫描或粘贴 vless 分享链接，然后到「插件 → Xray 代理」里保存。'),
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.h2 }, '1. 二维码图片'),
          h('input', { type: 'file', accept: 'image/*', onChange: onFile, disabled: scanning }),
          h('div', { style: styles.status, 'aria-live': 'polite' }, status),
        ),
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.h2 }, '2. 扫描屏幕二维码'),
          h(
            'div',
            { style: styles.row },
            h('button', { type: 'button', style: { ...styles.button, ...styles.primary }, onClick: startScreen, disabled: scanning }, scanning ? '扫描中…' : '开始扫描屏幕'),
            h('button', { type: 'button', style: styles.button, onClick: stop, disabled: !scanning }, '停止'),
          ),
          h('video', { ref: videoRef, playsInline: true, muted: true, style: styles.video }),
        ),
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.h2 }, '3. 分享链接'),
          h('textarea', {
            style: styles.textarea,
            value: text,
            placeholder: 'vless://uuid@host:443?security=reality&sni=...&pbk=...#备注',
            onChange: (event) => setText(event.target.value),
          }),
          h(
            'div',
            { style: styles.row },
            h('button', { type: 'button', style: { ...styles.button, ...styles.primary }, onClick: copy }, '复制链接'),
            h('span', { style: { ...styles.status, marginTop: 0, color: statusKind === 'error' ? '#f87171' : statusKind === 'ok' ? '#4ade80' : undefined } }, status),
          ),
          h(
            'ol',
            { style: styles.steps },
            h('li', null, '复制上面的 vless:// 链接；'),
            h('li', null, '打开 设置 → 插件 → Xray 代理，粘贴到「分享链接」并保存；'),
            h('li', null, '重启 DSH，状态变为 ready 后即生效。'),
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, XrayPage),
          ),
        'dsh-2xray: main panel',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: () => '2Xray' }, GlobeIcon),
          ),
        'dsh-2xray: sidebar entry',
      )
    }

    return { apply, inject, PANEL_ID }
  },
})
