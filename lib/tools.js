import { loadHarnessModule } from './route.js'

/**
 * Model-facing tools for the control plane. Registered lazily and optionally:
 * a profile without the `tools` service, or a layout where `@deepseek-ai/dsh-tools`
 * cannot be resolved, keeps the proxy working and just skips the tools.
 *
 * `defineTool` is imported from the harness installation because the tool
 * registry validates and renders through that exact module instance.
 */
export async function installTools({ ctx, supervisor, logger, loadToolsModule = loadHarnessModule }) {
  if (typeof ctx.inject !== 'function') {
    logger?.debug?.('ctx.inject 不可用，跳过 xray_* 工具注册')
    return false
  }
  const found = await loadToolsModule('@deepseek-ai/dsh-tools')
  const defineTool = found?.module?.defineTool
  if (typeof defineTool !== 'function') {
    logger?.warn?.('找不到 @deepseek-ai/dsh-tools，xray_* 工具未注册；插件其余功能不受影响')
    return false
  }

  ctx.inject(['tools'], (child) => {
    try {
      child.tools.register(
        defineTool({
          name: 'xray_status',
          description:
            'Show the Xray proxy supervisor status: process state, route takeover, functional probe, active node and control-plane reachability. Read-only.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            return JSON.stringify(supervisor.snapshot(), null, 2)
          },
        }),
      )

      child.tools.register(
        defineTool({
          name: 'xray_validate_config',
          description:
            'Validate the Xray config generated from the current settings with `xray run -test`, without starting, stopping or restarting the proxy. Read-only pre-flight; returns { ok, detail, configHash }.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            return JSON.stringify(await supervisor.validateConfig())
          },
        }),
      )

      child.tools.register(
        defineTool({
          name: 'xray_switch_node',
          description:
            'Switch the active Xray outbound to a configured node without restarting the process. The local inbound and the harness proxy policy stay untouched. Returns the pinned outbound tag.',
          parameters: {
            node: {
              type: 'string',
              required: true,
              description: 'Node id or outbound tag from the plugin config, e.g. "hk-01" or "proxy-hk-01".',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute(args) {
            const activeNode = await supervisor.switchNode(args.node)
            return JSON.stringify({ activeNode })
          },
        }),
      )

      child.tools.register(
        defineTool({
          name: 'xray_stats',
          description:
            'Read cumulative traffic counters per configured node (uplink/downlink bytes since Xray started). Counters are not a rate; pass reset=true to zero them after reading.',
          parameters: {
            reset: {
              type: 'boolean',
              description: 'Reset the counters after this read. Defaults to false.',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute(args) {
            return JSON.stringify(await supervisor.queryStats({ reset: args.reset === true }))
          },
        }),
      )
      child.tools.register(
        defineTool({
          name: 'xray_start',
          description:
            'Start the Xray child process now with the current saved settings. Since 0.9.0 a settings save applies immediately; this tool is for an explicit start (e.g. after the child was stopped manually). Fails with a readable reason when the settings have enabled=false or the config is invalid.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            const current = supervisor.snapshot()
            if (!current.enabled) {
              return JSON.stringify({
                ok: false,
                reason: 'disabled',
                hint: '设置里 enabled=false。在插件设置页打开「启用」并保存即可，0.9.0 起保存后即时生效，无需重启 DSH。',
                status: current,
              })
            }
            await supervisor.start()
            const status = supervisor.snapshot()
            return JSON.stringify({ ok: status.state === 'ready', status })
          },
        }),
      )

      child.tools.register(
        defineTool({
          name: 'xray_stop',
          description:
            'Stop the Xray child process and restore the harness proxy policy, without disposing the plugin. The next xray_start / settings save can bring it back. Use xray_status to inspect the result.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            await supervisor.pause('manual-stop')
            return JSON.stringify({ ok: true, status: supervisor.snapshot() })
          },
        }),
      )

      child.tools.register(
        defineTool({
          name: 'xray_restart',
          description:
            'Restart the Xray child process with the current saved settings (re-reads the generated config, re-runs the functional probe and re-installs the route). Use it after the node/inbound/routing settings changed if a plain settings save did not apply.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            const current = supervisor.snapshot()
            if (!current.enabled) {
              return JSON.stringify({
                ok: false,
                reason: 'disabled',
                hint: '设置里 enabled=false；先在插件设置页打开「启用」并保存（保存即生效）。',
                status: current,
              })
            }
            await supervisor.reload('manual-restart')
            const status = supervisor.snapshot()
            return JSON.stringify({ ok: status.state === 'ready', status })
          },
        }),
      )
      logger?.info?.(
        '已注册 xray_status / xray_validate_config / xray_switch_node / xray_stats / xray_start / xray_stop / xray_restart 工具',
      )
    } catch (error) {
      logger?.warn?.(`注册 xray_* 工具失败：${String(error)}`)
    }
  })
  return true
}
