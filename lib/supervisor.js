import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { buildXrayConfig } from './xray-config.js'
import { resolveBinary, probeVersion, tail } from './binary.js'
import { httpProxyProbe, portIsFree, waitForPort } from './health.js'
import { atomicWriteJson, sha256 } from './paths.js'

const CONFIG_REJECTED = 23

function safeTail(handle) {
  try {
    return handle?.stderrTail?.() ?? ''
  } catch {
    return ''
  }
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host
}

function withTimeout(promise, ms) {
  return raceTimeout(
    Promise.resolve(promise)
      .then(() => true)
      .catch(() => false),
    ms,
    false,
  )
}

/** Race a promise against a timer that is always cleared, so tests exit fast. */
function raceTimeout(promise, ms, timeoutValue) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutValue), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Owns the xray child lifecycle and the route decision for one plugin load.
 *
 * Invariants:
 *  A. The dispatcher is installed only after the inbound answered a TCP connect
 *     and (when enabled) a real proxied request; it is never pointed at a port
 *     that is not proven alive.
 *  B. Restore happens before terminate, so no window exists where the process
 *     is gone but the dispatcher still points at it.
 *  C. `stop()` waits for an in-flight `start()`, so a spawn cannot land after
 *     teardown and leak a process that owns the port.
 *  D. Every self-owned promise chain is caught; an unhandled rejection would
 *     dispose the whole harness process.
 */
export class Supervisor {
  #state = 'idle'
  #reason
  #detail
  #generation = 0
  #restarts = 0
  #handle
  #startTask
  #stopRequested = false
  #stopped = false
  #abort = new AbortController()
  #restartTimer
  #healthTimer
  #unhealthy = 0
  #binary
  #version
  #configHash
  #functionalProbe = 'pending'
  #lastExit
  #lastStdio = ''
  #startedAt
  #updatedAt = Date.now()
  #snapshotCache
  #publishChain = Promise.resolve()
  #logger
  #route
  #launcher
  #probes
  #resolveBinaryFn
  #control
  #activeNode
  #schemaLoaded = false
  #now

  constructor({
    config,
    errors = [],
    warnings = [],
    launcher,
    route,
    logger,
    dataDir,
    statusPath,
    probes = {},
    resolveBinaryFn = resolveBinary,
    control,
    schemaLoaded = false,
    now = () => Date.now(),
  }) {
    this.config = config
    this.errors = errors
    this.warnings = warnings
    this.#launcher = launcher
    this.#route = route
    this.#control = control
    this.#schemaLoaded = schemaLoaded
    this.#activeNode = config.activeNode
    this.#logger = logger
    this.dataDir = dataDir
    this.statusPath = statusPath ?? (dataDir ? join(dataDir, 'status.json') : undefined)
    this.#probes = {
      waitForPort,
      httpProxyProbe,
      portIsFree,
      ...probes,
    }
    this.#resolveBinaryFn = resolveBinaryFn
    this.#now = now
  }

  snapshot() {
    if (!this.#snapshotCache) this.#snapshotCache = this.#buildSnapshot()
    return this.#snapshotCache
  }

  /** Wait until a predicate over the latest snapshot holds, for tests and tools. */
  waitFor(predicate, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
    const immediate = predicate(this.snapshot())
    if (immediate) return Promise.resolve(this.snapshot())
    return new Promise((resolve, reject) => {
      const started = this.#now()
      const timer = setInterval(() => {
        const snap = this.snapshot()
        if (predicate(snap)) {
          clearInterval(timer)
          resolve(snap)
        } else if (this.#now() - started > timeoutMs) {
          clearInterval(timer)
          reject(new Error(`waitFor timeout; state=${snap.state} reason=${snap.reason ?? 'none'}`))
        }
      }, intervalMs)
    })
  }

  async start() {
    if (this.#stopped) return this.snapshot()
    if (this.#startTask) return this.#startTask
    this.#startedAt ??= this.#now()
    this.#startTask = this.#run()
      .catch((error) => {
        this.#setState('failed', 'internal-error', String(error))
      })
      .finally(() => {
        this.#startTask = undefined
      })
    return this.#startTask
  }

  async stop() {
    if (this.#stopped) return
    this.#stopped = true
    this.#stopRequested = true
    this.#abort.abort()
    this.#stopHealthLoop()
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    try {
      await this.#startTask
    } catch {
      // start() never rejects; belt and braces
    }
    // Invariant B: restore the dispatcher before the process disappears.
    await this.#route.restore().catch((error) => this.#logger?.warn?.(`恢复路由失败：${String(error)}`))
    const handle = this.#handle
    this.#handle = undefined
    if (handle) {
      await handle.terminate().catch(() => {})
      const exited = await withTimeout(handle.waitForExit(), Math.max(1000, this.config.lifecycle.stopGraceMs + 1000))
      if (!exited) {
        this.#logger?.warn?.('xray 子进程未在 stopGraceMs 内退出，交由服务/Job Object 兜底')
        this.#lastStdio = safeTail(handle) || this.#lastStdio
      }
    }
    this.#setState('stopped', 'disposed')
  }

  async #run() {
    const generation = ++this.#generation
    const signal = this.#abort.signal
    const lifecycle = this.config.lifecycle

    if (!this.config.enabled) {
      this.#setState('idle', 'disabled')
      return
    }
    if (this.errors.length > 0) {
      this.#setState('failed', 'config-invalid', this.errors.map((error) => `${error.field}: ${error.message}`).join('; '))
      return
    }

    this.#setState('resolving')
    let binary
    try {
      binary = await this.#resolveBinaryFn({
        config: this.config,
        dataDir: this.dataDir,
        launcher: this.#launcher,
      })
    } catch (error) {
      this.#setState('failed', error.code ?? 'binary-missing', error.message)
      return
    }
    this.#binary = binary
    if (signal.aborted) return

    const version = await probeVersion({
      launcher: this.#launcher,
      binaryPath: binary.path,
      timeoutMs: 5000,
    }).catch((error) => ({ ok: false, detail: String(error) }))
    if (!version.ok) {
      this.#setState('failed', 'binary-unusable', version.detail)
      return
    }
    this.#version = version.version
    if (signal.aborted) return

    const xrayConfig = buildXrayConfig(this.config)
    const text = JSON.stringify(xrayConfig, null, 2)
    this.#configHash = sha256(text)
    const configPath = join(this.dataDir, 'conf', 'xray-config.json')
    try {
      atomicWriteJson(configPath, xrayConfig, 0o600)
    } catch (error) {
      this.#setState('failed', 'config-write-failed', String(error))
      return
    }

    const host = this.config.inbound.host
    const port = this.config.inbound.port

    if (!(await this.#probes.portIsFree(host, port))) {
      this.#setState('failed', 'port-busy', `127.0.0.1:${port} 已被占用；不会静默改端口，请释放端口或修改 inbound.port`)
      return
    }
    if (signal.aborted) return

    const tested = await this.#runConfigTest(binary.path, configPath, generation)
    if (tested.aborted) return
    if (!tested.ok) {
      this.#setState('failed', 'config-rejected', tail(tested.detail))
      return
    }
    if (signal.aborted) return

    this.#setState('starting')
    let handle
    try {
      handle = this.#launcher.spawn({
        argv: [binary.path, 'run', '-c', configPath],
        cwd: this.dataDir,
        graceMs: Math.max(500, lifecycle.stopGraceMs),
        env: {},
      })
    } catch (error) {
      this.#setState('failed', 'spawn-failed', String(error))
      return
    }
    this.#handle = handle
    this.#watch(handle, generation)

    const readyOutcome = await Promise.race([
      this.#probes
        .waitForPort({
          host,
          port,
          timeoutMs: lifecycle.startTimeoutMs,
          signal,
        })
        .then((ok) => ({ ready: ok })),
      // A process that exits before it ever listens must be classified by the
      // exit watcher, not by a 15s port-poll timeout that would overwrite the
      // real reason and swallow the retry.
      handle.done.then(() => ({ exited: true })),
    ])
    if (signal.aborted) {
      await this.#killHandle(handle)
      return
    }
    if (readyOutcome.exited) return
    if (!readyOutcome.ready) {
      this.#lastStdio = safeTail(handle)
      await this.#killHandle(handle)
      if (generation !== this.#generation) return
      this.#setState('failed', 'start-timeout', `端口 ${port} 在 ${lifecycle.startTimeoutMs}ms 内未监听；stderr: ${tail(this.#lastStdio)}`)
      return
    }

    // Functional probe: proves the upstream path, not just the listener.
    if (this.config.functionalProbe.enabled) {
      const probe = await this.#probes.httpProxyProbe({
        host,
        port,
        url: this.config.functionalProbe.url,
        timeoutMs: this.config.functionalProbe.timeoutMs,
      })
      if (signal.aborted) {
        await this.#killHandle(handle)
        return
      }
      this.#functionalProbe = probe.ok ? 'pass' : `fail:${probe.status ?? probe.error ?? 'unknown'}`
      if (!probe.ok) {
        this.#lastStdio = safeTail(handle) || this.#lastStdio
        await this.#killHandle(handle)
        this.#setState(
          'failed',
          'functional-probe-failed',
          `经本地入站的探测请求失败（${probe.error ?? `status ${probe.status}`}）。` +
            '常见原因：uuid/flow/SNI/shortId/REALITY 公钥与服务端不一致，或远程不可达。' +
            '确认链路正常后可设置 functionalProbe.enabled: false 只做 TCP 就绪检查。',
        )
        return
      }
    } else {
      this.#functionalProbe = 'skipped'
    }

    if (this.config.takeover === 'off') {
      this.#setState('ready', 'takeover-off', 'xray 已就绪，但 takeover=off，未接管全局流量')
    } else {
      try {
        const scheme = this.config.inbound.protocol === 'socks' ? 'socks5' : 'http'
        const result = await this.#route.install({
          proxyUrl: `${scheme}://${formatHost(host)}:${port}`,
          noProxy: this.config.noProxy,
          force: this.config.takeover === 'force',
        })
        if (result.reason === 'external-proxy-active') {
          this.#setState('degraded', 'external-proxy-active', '启动器已有代理策略；未接管。设置 takeover: force 可强制覆盖')
        } else {
          this.#setState('ready')
        }
      } catch (error) {
        // The process is healthy; only routing failed. Keep it running so a
        // fixed config or a later retry can recover without a spawn storm.
        this.#setState('degraded', error.code ?? 'route-install-failed', error.message)
      }
    }

    await this.#applyActiveNode()

    if (signal.aborted) {
      await this.#killHandle(handle)
      return
    }
    this.#startHealthLoop(generation)
  }

  /**
   * Pin the balancer to the configured node after (re)start. The override lives
   * in the xray process, so a restart drops it and this re-applies it.
   */
  async #applyActiveNode() {
    if (!this.config.control.enabled || this.config.nodes.length <= 1 || !this.#control) return
    try {
      await this.#control.getBalancerInfo()
      await this.#control.overrideBalancerTarget(this.#activeNode)
    } catch (error) {
      const hint =
        String(error.code) === '12'
          ? '当前 xray 版本没有 RoutingService（本机实测 1.4.5 返回 UNIMPLEMENTED）；请升级到 2024-09 之后的版本（v1.8.24+/v24.9+）'
          : '出口暂由 balancer 的随机策略选择，切换工具不可用'
      this.#logger?.warn?.(`控制面不可用（${error.code ?? error.message}）：${hint}`)
    }
  }

  /**
   * Runtime node switch through the control plane. The process, the local
   * inbound and the installed dispatcher all stay untouched.
   *
   * @param {string} nodeRef - node id or outbound tag.
   * @returns {Promise<string>} the outbound tag now pinned.
   */
  async switchNode(nodeRef) {
    if (!this.config.control.enabled || !this.#control) {
      throw new Error('control.enabled=false，无法运行时切换节点')
    }
    if (this.config.nodes.length <= 1) {
      throw new Error('只有一个节点，没有可切换的 balancer')
    }
    const node = this.config.nodes.find((entry) => entry.id === nodeRef || entry.tag === nodeRef)
    if (!node) {
      throw new Error(`未知节点：${nodeRef}；可用：${this.config.nodes.map((entry) => entry.tag).join(', ')}`)
    }
    await this.#control.overrideBalancerTarget(node.tag)
    this.#activeNode = node.tag
    this.#publish()
    return node.tag
  }

  /**
   * Read xray's cumulative outbound counters and fold them per node tag.
   * StatsService counters are cumulative since process start, not a rate.
   */
  async queryStats({ reset = false } = {}) {
    if (!this.#control) throw new Error('control.enabled=false，无统计可用')
    const stats = await this.#control.queryStats({ patterns: ['outbound>>>'], reset })
    const byTag = {}
    for (const { name, value } of stats) {
      const match = /^outbound>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(name)
      if (!match) continue
      byTag[match[1]] ??= { uplink: 0, downlink: 0 }
      byTag[match[1]][match[2]] += value
    }
    return byTag
  }

  async #runConfigTest(binaryPath, configPath, generation) {
    if (this.#abort.signal.aborted || generation !== this.#generation) return { aborted: true }
    const outcome = await this.#runTestOnce(binaryPath, configPath)
    if (this.#abort.signal.aborted || generation !== this.#generation) return { aborted: true }
    return outcome
  }

  /**
   * Spawn `xray run -test -c <file>` once and report its exit facts. Never
   * binds a port: this is the safe pre-flight both startup and the
   * `xray_validate_config` tool use.
   */
  async #runTestOnce(binaryPath, configPath) {
    let handle
    try {
      handle = this.#launcher.spawn({
        argv: [binaryPath, 'run', '-test', '-c', configPath],
        cwd: this.dataDir ?? process.cwd(),
        graceMs: 2000,
        env: {},
      })
    } catch (error) {
      return { ok: false, detail: String(error) }
    }
    const outcome = await raceTimeout(handle.done, 10_000, { timedOut: true })
    if (outcome?.timedOut) {
      await handle.terminate()
      return { ok: false, detail: 'xray run -test 超时' }
    }
    return { ok: outcome.exitCode === 0, detail: `${handle.stdoutTail?.() ?? ''}\n${handle.stderrTail?.() ?? ''}` }
  }

  /**
   * Validate the config built from the *current* settings without starting or
   * restarting the proxy. Safe to call while `ready`.
   *
   * @returns {Promise<{ ok: boolean, detail: string, configHash: string }>}
   */
  async validateConfig() {
    // Field-level problems are known before spawning anything; report them in
    // the same shape so the model gets one contract for every failure.
    if (this.errors?.length > 0) {
      return {
        ok: false,
        reason: 'config-invalid',
        detail: this.errors.map((error) => `${error.field}: ${error.message}`).join('; '),
        configHash: null,
      }
    }
    if (!this.dataDir) {
      return { ok: false, reason: 'data-dir-unavailable', detail: '数据目录不可用，无法写入待校验的配置', configHash: null }
    }

    let binary
    try {
      binary =
        this.#binary ??
        (await this.#resolveBinaryFn({ config: this.config, dataDir: this.dataDir, launcher: this.#launcher }))
    } catch (error) {
      return {
        ok: false,
        reason: error.code ?? 'binary-missing',
        detail: error.message,
        configHash: null,
      }
    }

    const built = buildXrayConfig(this.config)
    const text = JSON.stringify(built, null, 2)
    const file = join(this.dataDir, 'conf', `validate-${Date.now()}-${process.pid}.json`)
    atomicWriteJson(file, built, 0o600)
    try {
      const outcome = await this.#runTestOnce(binary.path, file)
      return { ok: outcome.ok, reason: outcome.ok ? null : 'config-rejected', detail: tail(outcome.detail), configHash: sha256(text) }
    } finally {
      try {
        rmSync(file, { force: true })
      } catch {
        // best effort
      }
    }
  }

  #watch(handle, generation) {
    handle.done
      .then((outcome) => this.#onExit(handle, generation, outcome))
      .catch((error) => this.#onExit(handle, generation, { error }))
      // The watcher itself must never produce an unhandled rejection: that
      // would dispose the whole harness process.
      .catch((error) => this.#logger?.error?.(`处理 xray 退出时异常：${String(error)}`))
  }

  async #onExit(handle, generation, outcome) {
    if (this.#stopRequested) return
    if (generation !== this.#generation) return
    this.#generation++
    this.#stopHealthLoop()
    if (this.#handle === handle) this.#handle = undefined
    const stderr = safeTail(handle) || this.#lastStdio
    this.#lastStdio = stderr
    this.#lastExit = { exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, at: this.#now() }
    await this.#route.restore().catch(() => {})

    if (outcome?.exitCode === CONFIG_REJECTED) {
      this.#setState('failed', 'config-rejected', tail(stderr) || 'xray 以退出码 23 退出（配置错误），不会自动重启')
      return
    }
    if (/bind|address already in use|only one usage of each socket address/i.test(stderr)) {
      this.#setState('failed', 'port-busy', tail(stderr))
      return
    }
    this.#scheduleRestart('crashed', stderr)
  }

  #scheduleRestart(reason, detail) {
    if (this.#stopRequested || this.#stopped) return
    const lifecycle = this.config.lifecycle
    if (this.#restarts >= lifecycle.maxRestarts) {
      this.#setState('failed', 'restart-exhausted', `连续重启 ${this.#restarts} 次仍未恢复；最后一次：${tail(detail)}`)
      return
    }
    this.#restarts++
    const base = Math.min(lifecycle.backoffMs * 2 ** (this.#restarts - 1), lifecycle.backoffMaxMs)
    const delayMs = Math.round(base * (0.5 + Math.random() * 0.5))
    this.#setState('backoff', reason, `第 ${this.#restarts}/${lifecycle.maxRestarts} 次重启，约 ${delayMs}ms 后`)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      if (this.#stopRequested || this.#stopped) return
      const startAgain = () => {
        if (this.#stopRequested || this.#stopped || this.#startTask) return
        this.start().catch((error) => this.#logger?.error?.(`重启 xray 失败：${String(error)}`))
      }
      // The failed run may still be unwinding (for example a start-timeout
      // poll); wait for its task to settle before spawning a second process.
      if (this.#startTask) this.#startTask.then(startAgain, startAgain)
      else startAgain()
    }, delayMs)
    this.#restartTimer.unref?.()
  }

  #startHealthLoop(generation) {
    const interval = this.config.lifecycle.healthIntervalMs
    if (!(interval > 0)) return
    this.#stopHealthLoop()
    const tick = async () => {
      this.#healthTimer = undefined
      if (this.#stopRequested || this.#stopped || generation !== this.#generation) return
      try {
        const ok = await this.#probes.waitForPort({
          host: this.config.inbound.host,
          port: this.config.inbound.port,
          timeoutMs: Math.max(200, this.config.lifecycle.probeTimeoutMs),
          signal: this.#abort.signal,
        })
        if (this.#stopRequested || this.#stopped || generation !== this.#generation) return
        if (ok) {
          this.#unhealthy = 0
          if (this.#state === 'degraded' && this.#reason === 'unhealthy') this.#setState('ready', 'health-recovered')
        } else {
          this.#unhealthy++
          if (this.#unhealthy >= this.config.lifecycle.unhealthyThreshold) {
            await this.#recycle('unhealthy')
            return
          }
          this.#logger?.warn?.(`xray 健康探测失败 ${this.#unhealthy}/${this.config.lifecycle.unhealthyThreshold}`)
        }
      } catch (error) {
        this.#logger?.warn?.(`健康探测异常：${String(error)}`)
      }
      if (this.#stopRequested || this.#stopped) return
      this.#healthTimer = setTimeout(tick, interval)
      this.#healthTimer.unref?.()
    }
    this.#healthTimer = setTimeout(tick, interval)
    this.#healthTimer.unref?.()
  }

  #stopHealthLoop() {
    if (this.#healthTimer) {
      clearTimeout(this.#healthTimer)
      this.#healthTimer = undefined
    }
  }

  async #recycle(reason) {
    const generation = ++this.#generation
    this.#stopHealthLoop()
    await this.#route.restore().catch(() => {})
    const handle = this.#handle
    this.#handle = undefined
    this.#lastStdio = safeTail(handle) || this.#lastStdio
    if (handle) await this.#killHandle(handle)
    if (this.#stopRequested) return
    this.#logger?.warn?.(`xray 连续健康探测失败，回收进程（generation=${generation}）`)
    this.#scheduleRestart(reason, this.#lastStdio)
  }

  async #killHandle(handle) {
    if (!handle) return
    await handle.terminate().catch(() => {})
    await withTimeout(handle.waitForExit(), Math.max(1000, this.config.lifecycle.stopGraceMs))
    if (this.#handle === handle) this.#handle = undefined
  }

  #setState(state, reason, detail) {
    this.#state = state
    this.#reason = reason
    this.#detail = detail
    this.#updatedAt = this.#now()
    const line = `state=${state}${reason ? ` reason=${reason}` : ''}${detail ? ` detail=${detail}` : ''}`
    if (state === 'failed') this.#logger?.error?.(line)
    else if (state === 'degraded' || state === 'backoff') this.#logger?.warn?.(line)
    else this.#logger?.info?.(line)
    this.#publish()
  }

  #buildSnapshot() {
    const handle = this.#handle
    return {
      plugin: 'dsh-2xray',
      state: this.#state,
      reason: this.#reason ?? null,
      detail: this.#detail ?? null,
      enabled: this.config.enabled,
      takeover: this.config.takeover,
      settingsSchema: this.#schemaLoaded,
      nodes: this.config.nodes.map((node) => ({ id: node.id, tag: node.tag, address: node.address, port: node.port })),
      activeNode: this.#activeNode,
      control: this.#control ? { enabled: true, ...this.#control.snapshot() } : { enabled: false },
      generation: this.#generation,
      restarts: this.#restarts,
      port: this.config.inbound.port,
      portSource: 'config',
      binary: this.#binary
        ? { path: this.#binary.path, source: this.#binary.source, version: this.#version ?? null }
        : null,
      process: {
        pid: handle?.pid ?? null,
        alive: Boolean(handle),
        exitCode: this.#lastExit?.exitCode ?? null,
        stderrTail: tail(this.#lastStdio, 2000),
      },
      route: this.#route?.snapshot?.() ?? { installed: false, mode: 'none' },
      functionalProbe: this.#functionalProbe,
      configHash: this.#configHash ?? null,
      startedAt: this.#startedAt ?? null,
      updatedAt: this.#updatedAt,
    }
  }

  #publish() {
    this.#snapshotCache = this.#buildSnapshot()
    const snapshot = this.#snapshotCache
    if (!this.statusPath) return
    this.#publishChain = this.#publishChain
      .then(() => {
        try {
          atomicWriteJson(this.statusPath, snapshot, 0o600)
        } catch (error) {
          this.#logger?.warn?.(`写入 status.json 失败：${String(error)}`)
        }
      })
      .catch(() => {})
  }
}
