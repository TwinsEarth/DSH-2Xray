import { grpcUnary } from './grpc.js'
import {
  decodeBalancerInfo,
  decodeQueryStats,
  encodeGetBalancerInfo,
  encodeOverrideBalancer,
  encodeQueryStats,
} from './protobuf.js'

const ROUTING_SERVICE = '/xray.app.router.command.RoutingService'
const STATS_SERVICE = '/xray.app.stats.command.StatsService'

/**
 * Client for the Xray control plane exposed by the `api` inbound.
 *
 * The active node is switched by pinning the balancer to one outbound tag:
 * every node is already an outbound in the static config, so no handler is
 * added or removed and no protobuf-encoded outbound config is needed.
 */
export class ControlClient {
  #host
  #port
  #timeoutMs
  #balancerTag
  #logger
  #state = { reachable: undefined, lastError: undefined, activeTarget: undefined, checkedAt: undefined }

  constructor({ host = '127.0.0.1', port, timeoutMs = 3000, balancerTag = 'active', logger } = {}) {
    this.#host = host
    this.#port = port
    this.#timeoutMs = timeoutMs
    this.#balancerTag = balancerTag
    this.#logger = logger
  }

  get balancerTag() {
    return this.#balancerTag
  }

  async #call(path, message) {
    try {
      const response = await grpcUnary({
        host: this.#host,
        port: this.#port,
        path,
        message,
        timeoutMs: this.#timeoutMs,
      })
      this.#state.reachable = true
      this.#state.lastError = undefined
      this.#state.checkedAt = Date.now()
      return response
    } catch (error) {
      this.#state.reachable = false
      this.#state.lastError = `${error.code ?? 'ERROR'}: ${error.message}`
      this.#state.checkedAt = Date.now()
      throw error
    }
  }

  /** Read the balancer state; also serves as the reachability check. */
  async getBalancerInfo() {
    const response = await this.#call(
      `${ROUTING_SERVICE}/GetBalancerInfo`,
      encodeGetBalancerInfo({ tag: this.#balancerTag }),
    )
    const info = decodeBalancerInfo(response)
    if (info.overrideTarget !== undefined) this.#state.activeTarget = info.overrideTarget
    return info
  }

  /** Pin the balancer to one outbound tag (the runtime node switch). */
  async overrideBalancerTarget(target) {
    await this.#call(
      `${ROUTING_SERVICE}/OverrideBalancerTarget`,
      encodeOverrideBalancer({ balancerTag: this.#balancerTag, target }),
    )
    this.#state.activeTarget = target
    this.#logger?.info?.(`已切换 Xray 出口：${target}`)
    return target
  }

  /** Query traffic counters. Names look like `outbound>>>tag>>>traffic>>>uplink`. */
  async queryStats({ patterns = ['outbound>>>'], reset = false } = {}) {
    const response = await this.#call(`${STATS_SERVICE}/QueryStats`, encodeQueryStats({ patterns, reset }))
    return decodeQueryStats(response)
  }

  snapshot() {
    return {
      host: this.#host,
      port: this.#port,
      balancerTag: this.#balancerTag,
      reachable: this.#state.reachable ?? null,
      activeTarget: this.#state.activeTarget ?? null,
      lastError: this.#state.lastError ?? null,
      checkedAt: this.#state.checkedAt ?? null,
    }
  }
}
