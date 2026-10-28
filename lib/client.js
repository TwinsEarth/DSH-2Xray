window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-2xray',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'xray'
    const NS = 'xray-proxy'
    const inject = ['slots', 'locale']

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

    function NodeTable({ status }) {
      const nodes = status?.nodes ?? []
      if (nodes.length === 0) {
        return h('div', { style: { ...C.muted, padding: '10px 0', fontSize: 12.5 } }, '还没有节点。到「设置 → 插件 → Xray 代理」粘贴 vless 链接并保存，重启 DSH 后这里会显示。')
      }
      return h(
        'table',
        { style: C.table },
        h('thead', null, h('tr', null,
          h('th', { style: C.th }), h('th', { style: C.th }, '节点'), h('th', { style: C.th }, '地址'),
          h('th', { style: C.th }, '端口'), h('th', { style: C.th }, '状态'))),
        h('tbody', null, nodes.map((node) => {
          const active = node.tag === status.activeNode
          return h('tr', { key: node.tag },
            h('td', { style: C.td }, active
              ? h('span', { style: { ...C.dot, background: '#15803d', display: 'inline-block' } })
              : h('span', { style: { ...C.dot, border: '1px solid currentColor', background: 'transparent', display: 'inline-block' } })),
            h('td', { style: C.td }, node.id ?? node.tag),
            h('td', { style: { ...C.td, ...C.mono } }, node.address || '—'),
            h('td', { style: { ...C.td, ...C.mono } }, node.port ?? '—'),
            h('td', { style: C.td }, active ? '当前' : '—'))
        })),
      )
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

      return h('div', { style: C.page },
        h('div', { style: C.header },
          h('span', { style: C.globe }, h(GlobeIcon, { size: 22 })),
          h('div', null,
            h('h1', { style: C.title }, '2Xray'),
            h('p', { style: C.sub }, `Xray 全局代理 · 本地 ${localEndpoint}`)),
          h(StatusPill, { status })),
        error
          ? h('div', { style: { ...C.card, ...C.error, fontSize: 12.5 } }, `状态通道不可用：${error}（代理本身可能仍在工作）`)
          : null,
        status?.reason && status.state !== 'ready'
          ? h('div', { style: { ...C.card, fontSize: 12.5 } }, h('b', null, '原因：'), ` ${status.reason}`,
              status.detail ? h('div', { style: { ...C.muted, marginTop: 4 } }, status.detail) : null)
          : null,
        h('section', { style: C.card },
          h('div', { style: C.cardHead }, '当前 VPN 配置',
            h('span', { style: { ...C.muted, fontWeight: 400, marginLeft: 'auto' } }, `${status?.nodes?.length ?? 0} 个节点`)),
          h(NodeTable, { status })),
        h('section', { style: C.card },
          h('div', { style: C.cardHead }, '实时连接日志'),
          h(LogList, { logs, setLogs })),
        h('div', { style: C.statusBar },
          h('span', { style: { ...C.dot, background: phase.color } }),
          h('b', null, phase.label),
          h('span', { style: { ...C.mono, fontWeight: 600 } }, latency == null ? '延迟 —' : `延迟 ${latency} ms`),
          h('span', { style: { ...C.mono } }, status?.vpnName ? String(status.vpnName) : '—'),
          h('span', { style: { ...C.mono } }, egress?.ip ? `出口 ${egress.ip}${egress.country ? ` (${egress.country})` : ''}` : '出口 IP —'),
          h('span', { style: { ...C.muted, marginLeft: 'auto' } }, status?.updatedAt ? `更新于 ${fmtTime(status.updatedAt)}` : '等待状态')))
    }

    function Field({ label, children }) {
      return h('div', null, h('label', { style: C.label }, label), children)
    }

    function readFormValue(form) {
      try {
        const snapshot = form?.getSnapshot?.()
        const candidate = snapshot?.value ?? snapshot?.state?.view?.value ?? snapshot?.view?.value
        return candidate && typeof candidate === 'object' ? candidate : {}
      } catch {
        return {}
      }
    }

    async function setField(form, field, value) {
      if (typeof form?.set === 'function' && typeof field === 'string') return form.set(field, value)
      const snapshot = form?.getSnapshot?.()
      const revision = snapshot?.revision ?? snapshot?.state?.view?.revision
      if (typeof form?.mutate === 'function') {
        return form.mutate([{ op: 'set', path: Array.isArray(field) ? field : [field], value }], revision)
      }
      throw new Error('设置表单不可写')
    }

    function XraySettingsCard({ form }) {
      const value = readFormValue(form)
      const [shareLink, setShareLink] = React.useState(value.shareLink ?? '')
      const [binaryPath, setBinaryPath] = React.useState(value.binary?.path ?? '')
      const [port, setPort] = React.useState(String(value.inbound?.port ?? 20808))
      const [enabled, setEnabled] = React.useState(value.enabled === true)
      const [takeover, setTakeover] = React.useState(value.takeover ?? 'auto')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const save = async () => {
        setBusy(true)
        try {
          await setField(form, 'shareLink', shareLink.trim())
          await setField(form, 'enabled', enabled)
          await setField(form, 'takeover', takeover)
          const numericPort = Number(port)
          if (Number.isInteger(numericPort) && numericPort > 0) await setField(form, ['inbound', 'port'], numericPort)
          if (binaryPath.trim()) await setField(form, ['binary', 'path'], binaryPath.trim())
          setMessage('已保存，重启 DSH 后生效。')
        } catch (error) {
          setMessage('保存失败：' + (error.message || error))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { ...C.card, marginTop: 8 } },
        h('div', { style: C.cardHead }, h(GlobeIcon), '2Xray 连接'),
        h(Field, { label: 'VLESS 分享链接（粘贴或扫码）' },
          h('textarea', {
            style: { ...C.input, minHeight: 64, fontFamily: 'ui-monospace, Consolas, monospace' },
            value: shareLink,
            placeholder: 'vless://uuid@host:443?security=reality&sni=...&pbk=...#备注',
            onChange: (event) => setShareLink(event.target.value),
          })),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
            h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }), '启用代理'),
          h('label', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } }, 'takeover',
            h('select', { value: takeover, onChange: (event) => setTakeover(event.target.value), style: { padding: '4px 8px', borderRadius: 6, background: 'transparent', color: 'inherit' } },
              h('option', { value: 'auto' }, 'auto'), h('option', { value: 'force' }, 'force'), h('option', { value: 'off' }, 'off')))),
        h(Field, { label: 'xray 可执行文件路径（留空自动查找）' },
          h('input', { style: { ...C.input, fontFamily: 'ui-monospace, Consolas, monospace' }, value: binaryPath, placeholder: '例如 D:\\v2rayN\\xray.exe', onChange: (event) => setBinaryPath(event.target.value) })),
        h(Field, { label: '本地 HTTP 入站端口' },
          h('input', { style: C.input, value: port, onChange: (event) => setPort(event.target.value) })),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 } },
          h('button', { type: 'button', style: C.primaryBtn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('span', { style: { ...C.muted, fontSize: 12 } }, message)),
        h('p', { style: { ...C.muted, fontSize: 12, marginTop: 10 } }, '打开左侧「2Xray」面板可扫码导入、查看节点/日志/延迟/出口 IP。'))
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
            child.effect(
              () =>
                child.configForms.whileServed([NS], () =>
                  child.slots.inject('plugins.item', () =>
                    child.slots.register(
                      {
                        name: 'plugins.item',
                        id: PANEL_ID,
                        order: 40,
                        label: () => '2Xray 连接',
                        inject: () => ({ form: child.configForms.get(NS) }),
                      },
                      XraySettingsCard,
                    ),
                  ),
                ),
              'dsh-2xray: settings card',
            )
          } catch {
            // a client without the settings service keeps the sidebar panel
          }
        })
      }
    }

    return { apply, inject, PANEL_ID, NS }
  },
})
