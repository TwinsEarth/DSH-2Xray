import { normalizeConfig } from './lib/config.js'
import { createLazyLauncher } from './lib/process.js'
import { RouteManager } from './lib/route.js'
import { Supervisor } from './lib/supervisor.js'
import { createLogger } from './lib/log.js'
import { resolveDataDir } from './lib/paths.js'
import { ControlClient } from './lib/control/client.js'
import { installTools } from './lib/tools.js'
import { LogBuffer } from './lib/logbuf.js'
import { Monitor } from './lib/monitor.js'
import { checkForUpdate, installUpdate, ownVersion } from './lib/update.js'
import { geodataStatus, updateGeodata } from './lib/geodata.js'

export const name = 'dsh-2xray'

/**
 * Settings schema, exported only when the harness copy of Schemastery is
 * resolvable (it lives beside the plugin in the profile). Without it the plugin
 * keeps working from YAML config; the Plugins page simply shows no form.
 */
let Config
try {
  ;({ Config } = await import('./lib/schema.js'))
} catch {
  Config = undefined
}
export { Config }

/**
 * Host half of dsh-2xray: it supervises one xray-core child process and
 * points the harness' process-global proxy policy at the local inbound.
 *
 * The entry point never throws for a bad configuration, a missing binary, or
 * an unreachable upstream: those become a `failed(...)` state with a reason
 * chain in the log and `status.json`. That keeps the patch row active, so the
 * user can fix the config instead of losing the plugin entirely.
 *
 * `apply` returns the cleanup registered through `ctx.effect`. Cordis has no
 * `ctx.on('dispose')` event (checked against 0.2.1-rc.3): `ctx.effect` and the
 * disposer returned from `apply` are the lifecycle seam.
 */
export function apply(ctx, rawConfig) {
  const ring = new LogBuffer(1000)
  const baseLogger = createLogger(ctx)
  const logger = {
    info: (...args) => {
      ring.append('info', args.join(' '))
      baseLogger.info(...args)
    },
    warn: (...args) => {
      ring.append('warn', args.join(' '))
      baseLogger.warn(...args)
    },
    error: (...args) => {
      ring.append('error', args.join(' '))
      baseLogger.error(...args)
    },
    debug: (...args) => baseLogger.debug(...args),
  }
  const { config, errors, warnings } = normalizeConfig(rawConfig)

  for (const warning of warnings) logger.warn(`配置警告：${warning}`)

  // Volatile-only settings writes do not remount the fiber; the value is in the
  // profile patch and takes effect on the next start or plugin reload.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', (paths) => {
      const changed = Array.isArray(paths) ? paths.join(', ') : String(paths ?? '')
      logger.info(`设置已保存（${changed}）；重启 DSH 后生效`)
    })
  }

  let dataDir
  try {
    dataDir = resolveDataDir(config)
  } catch (error) {
    errors.push({ field: 'binary.dataDir', message: `无法创建数据目录：${String(error)}` })
  }

  if (config.enabled && !errors.length) {
    logger.info(
      `启动 xray：nodes=${config.nodes.length} active=${config.activeNode} ` +
        `flow=${config.nodes[0].flow || '(none)'} inbound=${config.inbound.protocol}://${config.inbound.host}:${config.inbound.port} ` +
        `takeover=${config.takeover} control=${config.control.enabled ? `127.0.0.1:${config.control.port}` : 'off'} ` +
        `dataDir=${dataDir ?? '(unavailable)'}`,
    )
    if (config.inbound.protocol === 'socks') {
      logger.warn('inbound.protocol=socks 时 DSH 的代理策略不覆盖 web_fetch；除非确有非 Node 客户端需要 SOCKS，建议改回 http')
    }
    if (!config.server.password && config.server.publicKey) {
      logger.info('使用旧字段 publicKey 配置 REALITY；xray 会同时读取 password，两者都写可兼容新旧版本')
    }  }

  const launcher = createLazyLauncher(ctx, { logger })
  const route = new RouteManager({ logger })
  const control =
    config.control.enabled
      ? new ControlClient({
          host: config.control.host,
          port: config.control.port,
          timeoutMs: config.control.timeoutMs,
          balancerTag: config.control.balancerTag,
          logger,
        })
      : undefined
  const supervisor = new Supervisor({
    config,
    errors,
    warnings,
    launcher,
    route,
    control,
    schemaLoaded: Boolean(Config),
    autoInstallCore: true,
    logger,
    dataDir,
  })

  const monitor = new Monitor({
    host: config.inbound.host,
    port: config.inbound.port,
    latencyUrl: config.functionalProbe.url,
    logger,
  })

  const updateState = {
    current: ownVersion(),
    latest: null,
    available: false,
    checkedAt: null,
    auto: config.updates?.auto === true,
    restartRequired: false,
    error: null,
    lastInstall: null,
  }
  let updateFlight = null
  const checkUpdate = async () => {
    if (updateFlight) return updateFlight
    updateFlight = checkForUpdate({ current: updateState.current })
      .then((info) => {
        Object.assign(updateState, info, { auto: config.updates?.auto === true, error: info.error ?? null })
        return info
      })
      .finally(() => {
        updateFlight = null
      })
    return updateFlight
  }

  // Authenticated status/log feed for the browser panel. Optional service: a
  // profile without `connection` keeps the proxy and the tools, it only loses
  // the live panel data.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (child) => {
      try {
        child.effect(
          () =>
            child.connection.fetch.register({
              path: '/api/xray/status',
              methods: ['GET'],
              requestBody: 'buffered',
              fetch: (request) => {
                const url = new URL(request.url)
                const after = Number(url.searchParams.get('after') ?? 0) || 0
                const snapshot = supervisor.snapshot()
                const proxied = snapshot.state === 'ready' && snapshot.route?.installed === true
                monitor.maybeRefresh({ ready: proxied })
                const node = snapshot.nodes?.find((entry) => entry.tag === snapshot.activeNode)
                const page = ring.since(after)
                const body = JSON.stringify({
                  ok: true,
                  status: {
                    ...snapshot,
                    proxied,
                    vpnName: node?.id ?? snapshot.activeNode ?? null,
                    probe: monitor.snapshot(),
                    update: updateState,
                    geodata: geodataStatus(dataDir),
                  },
                  logs: page.items,
                  cursor: page.cursor,
                })
                return new Response(body, {
                  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
                })
              },
            }),
          'dsh-2xray: status api',
        )
        child.effect(
          () =>
            child.connection.fetch.register({
              path: '/api/xray/switch',
              methods: ['POST'],
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  const body = await request.json()
                  const activeNode = await supervisor.switchNode(String(body?.node ?? ''))
                  return Response.json({ ok: true, activeNode })
                } catch (error) {
                  return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 400 })
                }
              },
            }),
          'dsh-2xray: switch api',
        )
        child.effect(
          () =>
            child.connection.fetch.register({
              path: '/api/xray/update',
              methods: ['GET', 'POST'],
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  if (request.method === 'GET') {
                    const url = new URL(request.url)
                    const stale = !updateState.checkedAt || Date.now() - updateState.checkedAt > 600_000
                    if (stale || url.searchParams.get('refresh') === '1') await checkUpdate()
                    return Response.json({ ok: true, update: updateState })
                  }
                  const body = await request.json().catch(() => ({}))
                  if (body.action === 'install') {
                    const info = updateState.available ? updateState : await checkUpdate()
                    if (!info.available) return Response.json({ ok: false, error: '已是最新版本', update: updateState }, { status: 409 })
                    const result = await installUpdate(info, { logger })
                    updateState.lastInstall = result
                    updateState.restartRequired = result.ok === true
                    updateState.latest = info.latest
                    return Response.json({ ok: result.ok, update: updateState, result })
                  }
                  await checkUpdate()
                  return Response.json({ ok: true, update: updateState })
                } catch (error) {
                  return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 400 })
                }
              },
            }),
          'dsh-2xray: update api',
        )
        child.effect(
          () =>
            child.connection.fetch.register({
              path: '/api/xray/healthz',
              methods: ['GET'],
              fetch: () => {
                const snapshot = supervisor.snapshot()
                return Response.json({
                  ok: true,
                  service: 'dsh-2xray',
                  version: `v${updateState.current}`,
                  state: snapshot.state,
                  ready: snapshot.state === 'ready',
                  routeInstalled: snapshot.route?.installed === true,
                })
              },
            }),
          'dsh-2xray: healthz api',
        )
      } catch (error) {
        logger.warn(`状态 API 注册失败：${String(error)}`)
      }
    })
  }

  // Opt-in auto-update: check once per start and install a newer tarball.
  // Loading the new code still requires a DSH restart, so this never restarts
  // the app behind the user's back.
  if (config.updates?.auto) {
    const timer = setTimeout(() => {
      ;(async () => {
        const info = await checkUpdate()
        if (!info.available) return
        const result = await installUpdate(info, { logger })
        updateState.restartRequired = result.ok === true
        if (result.ok) logger.info(`自动更新完成：${info.latest}；重启 DSH 后生效`)
      })().catch((error) => logger.warn(`自动更新检查失败：${String(error)}`))
    }, 5000)
    timer.unref?.()
  }

  const dispose = ctx.effect(
    () => async () => {
      await supervisor.stop()
    },
    'dsh-2xray/xray-supervisor',
  )

  const needsGeodata = config.routing?.mode === 'cn-direct' || config.routing?.geositeCn || config.routing?.blockAds
  const boot = async () => {
    if (dataDir && config.geodata?.autoUpdate !== false) {
      const status = geodataStatus(dataDir)
      if (status.missing.length > 0 && needsGeodata) {
        // Download before the first spawn, otherwise cn-direct would either
        // fail or degrade to global on a fresh machine.
        const result = await updateGeodata({ dataDir, logger, timeoutMs: 20_000 }).catch((error) => ({
          updated: [],
          failed: ['download'],
          error,
        }))
        if (result?.updated?.length > 0) logger.info('规则数据已下载，使用最新 geodata 启动 xray')
      }
      const refresh = () => {
        ;(async () => {
          if (!geodataStatus(dataDir).stale) return
          const result = await updateGeodata({ dataDir, logger })
          if (result?.updated?.length > 0) {
            logger.info('规则数据已更新，重启 xray 加载新数据')
            await supervisor.restart('geodata-updated')
          }
        })().catch((error) => logger.warn(`规则数据更新失败：${String(error)}`))
      }
      const first = setTimeout(refresh, 60_000)
      const daily = setInterval(refresh, 72 * 60 * 60 * 1000)
      first.unref?.()
      daily.unref?.()
    }
    await supervisor.start()
  }
  boot().catch((error) => logger.error(`xray 监督器异常：${String(error)}`))
  installTools({ ctx, supervisor, logger }).catch((error) => logger.warn(`安装 xray_* 工具失败：${String(error)}`))

  return dispose
}
