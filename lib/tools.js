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
      logger?.info?.('已注册 xray_status / xray_switch_node / xray_stats 工具')
    } catch (error) {
      logger?.warn?.(`注册 xray_* 工具失败：${String(error)}`)
    }
  })
  return true
}
