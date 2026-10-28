import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROXY_PACKAGE = '@deepseek-ai/dsh-http-proxy'
const PROBE_URL = 'https://api.deepseek.com/'
const DISPATCHER_SYMBOLS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')]

export class RouteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

/**
 * Anchor candidates for the harness installation. The desktop app ships one
 * asar archive; CLI layouts use a plain package directory. Every candidate is
 * tried with `createRequire` because module resolution inside an asar archive
 * works in the Electron-as-Node runtime, while a bare `import('undici')` from a
 * profile plugin does not (probed on 0.2.1-rc.3).
 */
export function installationAnchors({ execPath = process.execPath, env = process.env } = {}) {
  const dir = dirname(execPath)
  const candidates = [
    env.DSH_APP_ANCHOR,
    join(dir, 'resources', 'app.asar', 'dsh', 'package.json'),
    join(dir, 'resources', 'app', 'dsh', 'package.json'),
    join(dir, '..', 'Resources', 'app.asar', 'dsh', 'package.json'),
    join(dir, '..', 'Resources', 'app', 'dsh', 'package.json'),
  ]
  return candidates.filter(Boolean)
}

function tryResolve(anchor, specifier) {
  try {
    const require = createRequire(pathToFileURL(anchor))
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * Import the harness' own copy of a core package. Returning the module that the
 * launcher itself imported is what makes the policy singleton shared: a pnpm
 * copy installed for this plugin would have its own `active`/`installed`
 * variables and `web_fetch` would keep routing around it.
 */
export async function loadHarnessModule(specifier, { anchors = installationAnchors() } = {}) {
  for (const anchor of anchors) {
    const file = tryResolve(anchor, specifier)
    if (!file) continue
    try {
      const module = await import(pathToFileURL(file).href)
      return { module, file, anchor }
    } catch {
      // keep trying other anchors
    }
  }
  return undefined
}

export function currentGlobalDispatcher() {
  for (const symbol of DISPATCHER_SYMBOLS) {
    const dispatcher = globalThis[symbol]
    if (dispatcher) return dispatcher
  }
  return undefined
}

function isLoopback(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (host.startsWith('::ffff:')) return isLoopback(host.slice(7))
  return /^127\./.test(host)
}

function bypasses(noProxy, url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of String(noProxy ?? '').split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    let hostPart = entry
    let entryPort
    if (entry.startsWith('[')) {
      const close = entry.indexOf(']')
      if (close !== -1) {
        hostPart = entry.slice(1, close)
        const rest = entry.slice(close + 1)
        if (rest.startsWith(':')) entryPort = rest.slice(1)
      }
    } else {
      const first = entry.indexOf(':')
      if (first !== -1 && entry.indexOf(':', first + 1) === -1) {
        hostPart = entry.slice(0, first)
        entryPort = entry.slice(first + 1)
      }
    }
    if (entryPort !== undefined && entryPort !== port) continue
    const candidate = hostPart.replace(/^\*?\./, '').replace(/\.$/, '')
    if (!candidate) continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

const STREAM_OPTIONS = {
  // A long-lived SSE stream occupies one pooled connection; the cap must stay
  // above peak concurrent streams or the extra request queues until the
  // harness' 300s idle watchdog kills it.
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  // Fail proxy/upstream faults before the harness' own watchdog would.
  headersTimeout: 120_000,
  // Must exceed the provider's 300s stream idle budget so a quiet long
  // reasoning turn is not misread as a transport failure.
  bodyTimeout: 330_000,
  connectTimeout: 15_000,
  allowH2: true,
}

/**
 * Owns the process-global proxy policy for one plugin instance.
 *
 * Harness mode installs the DSH policy through its public entry point, which
 * keeps `fetch` and `web_fetch` reading the same answer. Builtin mode is the
 * fallback for layouts where that package cannot be resolved: it installs a
 * dispatcher itself and explicitly reports that `web_fetch` is not covered.
 *
 * Installation is idempotent and restore is ordered: the dispatcher is put back
 * before any agent it replaced is closed, otherwise in-flight requests fail
 * with UND_ERR_DESTROYED.
 */
export class RouteManager {
  #installed
  #sentinelSeq = 0
  #logger
  #loadHarness
  #loadUndici

  constructor({ logger, loadHarness = loadHarnessModule, loadUndici } = {}) {
    this.#logger = logger
    this.#loadHarness = loadHarness
    this.#loadUndici = loadUndici ?? (async () => (await loadHarnessModule('undici'))?.module)
  }

  get installed() {
    return Boolean(this.#installed)
  }

  snapshot() {
    const installed = this.#installed
    if (!installed) return { installed: false, mode: 'none', proxy: null, webFetchCovered: false, sentinel: null }
    return {
      installed: true,
      mode: installed.mode,
      proxy: installed.proxy,
      webFetchCovered: installed.mode === 'harness',
      sentinel: installed.sentinel,
      dispatcherIsOurs: currentGlobalDispatcher() === installed.dispatcher,
    }
  }

  /**
   * @param {object} options
   * @param {string} options.proxyUrl - e.g. http://127.0.0.1:20808
   * @param {string} [options.noProxy] - comma separated bypass list
   * @param {boolean} [options.force] - install even if a proxy is already active
   * @returns {Promise<object>} snapshot plus `reason` when not installed
   */
  async install({ proxyUrl, noProxy = '', force = false }) {
    if (this.#installed) return { ...this.snapshot(), reason: 'already-installed' }

    // The harness policy rejects SOCKS URLs by design, so a SOCKS inbound can
    // only work through our own dispatcher — and then `web_fetch` is not
    // covered. This is the documented cost of choosing socks over http.
    if (proxyUrl.startsWith('socks')) {
      return this.#installBuiltin({ proxyUrl, noProxy })
    }

    const harness = await this.#loadHarness(PROXY_PACKAGE)
    if (harness && typeof harness.module.installProxyFromEnvironment === 'function' && typeof harness.module.proxyRouteFor === 'function') {
      if (!force) {
        const before = harness.module.proxyRouteFor(new URL(PROBE_URL))
        if (before?.proxied) {
          this.#logger?.info?.('检测到启动器已安装的代理策略，takeover=auto 时不覆盖；设置 takeover: force 可强制接管')
          return { ...this.snapshot(), reason: 'external-proxy-active' }
        }
      }

      const values = { http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: noProxy }
      const env = {
        get(name) {
          const value = values[String(name).toLowerCase()]
          return value === undefined ? undefined : { value }
        },
      }
      const sentinel = `harness-${++this.#sentinelSeq}`
      const disposer = await harness.module.installProxyFromEnvironment(env, (message) =>
        this.#logger?.warn?.(`代理策略诊断：${message}`),
      )
      const after = harness.module.proxyRouteFor(new URL(PROBE_URL))
      if (!after?.proxied || after.proxy !== proxyUrl) {
        // Either a different module instance (its singleton did not change) or
        // a policy that did not accept the URL. Restore and fall back rather
        // than pretending the traffic is proxied.
        await Promise.resolve(disposer()).catch(() => {})
        throw new RouteError(
          'route-instance-mismatch',
          `已调用 ${PROXY_PACKAGE} 的 installProxyFromEnvironment，但 proxyRouteFor() 未返回代理路由；` +
            '说明插件拿到的是另一份模块实例。请改用 builtin 模式或把该包声明为可解析的同版本依赖。',
        )
      }
      this.#installed = {
        mode: 'harness',
        proxy: proxyUrl,
        sentinel,
        disposer,
        dispatcher: after.dispatcher,
      }
      this.#logger?.info?.(`全局代理策略已接管：${proxyUrl}（sentinel=${sentinel}）`)
      return this.snapshot()
    }

    // Fallback: install a dispatcher ourselves. This keeps model requests
    // proxied but leaves `web_fetch` on its pinned direct path.
    return this.#installBuiltin({ proxyUrl, noProxy })
  }

  async #installBuiltin({ proxyUrl, noProxy }) {
    const undici = await this.#loadUndici()
    if (!undici) {
      throw new RouteError('route-unavailable', '找不到 dsh-http-proxy 或 undici，无法接管全局代理')
    }
    const { Agent, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = undici
    const previous = getGlobalDispatcher()
    const agent = new Agent({
      ...STREAM_OPTIONS,
      factory(origin, options) {
        const url = new URL(origin.toString())
        if (isLoopback(url.hostname) || bypasses(noProxy, url)) return new Pool(origin, options)
        return new ProxyAgent({ ...options, uri: proxyUrl, proxyTunnel: true })
      },
    })
    setGlobalDispatcher(agent)
    const sentinel = `builtin-${++this.#sentinelSeq}`
    this.#installed = { mode: 'builtin', proxy: proxyUrl, sentinel, agent, previous, dispatcher: agent }
    const reason = proxyUrl.startsWith('socks')
      ? 'SOCKS 入站无法走 DSH 代理策略，已用内置 undici dispatcher 接管全局 fetch'
      : `未能加载 ${PROXY_PACKAGE}，已用内置 undici dispatcher 接管全局 fetch`
    this.#logger?.warn?.(`${reason}（sentinel=${sentinel}）；web_fetch 仍走直连路径，这是已知缺口`)
    return this.snapshot()
  }

  async restore() {
    const installed = this.#installed
    if (!installed) return
    this.#installed = undefined
    if (installed.mode === 'harness') {
      await Promise.resolve(installed.disposer()).catch((error) => {
        this.#logger?.warn?.(`恢复原代理策略失败：${String(error)}`)
      })
      this.#logger?.info?.('已恢复启动器原有的代理策略')
      return
    }
    const undici = await this.#loadUndici()
    if (undici) {
      undici.setGlobalDispatcher(installed.previous)
      const closed = await new Promise((resolve) => {
        let timer
        const settle = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        Promise.resolve(installed.agent.close()).then(
          () => settle(true),
          () => settle(true),
        )
        timer = setTimeout(() => settle(false), 5000)
        timer.unref?.()
      })
      if (!closed) {
        try {
          installed.agent.destroy()
        } catch {
          // best effort
        }
      }
    }
    this.#logger?.info?.('已恢复原始全局 dispatcher')
  }
}
