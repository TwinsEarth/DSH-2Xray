import http from 'node:http'

/**
 * Latency and egress-IP probes. Both go through the local HTTP inbound with an
 * absolute-form request line, so they exercise the tunnel instead of the
 * direct network. Plain http only: no CONNECT/TLS work is needed here.
 */
export class Monitor {
  #host
  #port
  #latencyUrl
  #egressUrl
  #latencyTimeoutMs
  #egressTimeoutMs
  #latencyTtlMs
  #egressTtlMs
  #logger
  #state = {
    latency: { ms: null, at: null, state: 'idle' },
    egress: { ip: null, country: null, at: null, state: 'idle' },
  }
  #latencyFlight = null
  #egressFlight = null

  constructor({
    host = '127.0.0.1',
    port = 20808,
    latencyUrl = 'http://cp.cloudflare.com/generate_204',
    egressUrl = 'http://ip-api.com/json/?fields=status,country,countryCode,query',
    latencyTimeoutMs = 4000,
    egressTimeoutMs = 5000,
    latencyTtlMs = 30_000,
    egressTtlMs = 600_000,
    logger,
  } = {}) {
    this.#host = host
    this.#port = port
    this.#latencyUrl = latencyUrl
    this.#egressUrl = egressUrl
    this.#latencyTimeoutMs = latencyTimeoutMs
    this.#egressTimeoutMs = egressTimeoutMs
    this.#latencyTtlMs = latencyTtlMs
    this.#egressTtlMs = egressTtlMs
    this.#logger = logger
  }

  snapshot() {
    const now = Date.now()
    const latencyFresh = this.#state.latency.at !== null && now - this.#state.latency.at < this.#latencyTtlMs
    const egressFresh = this.#state.egress.at !== null && now - this.#state.egress.at < this.#egressTtlMs
    return {
      latency: { ...this.#state.latency, stale: !latencyFresh },
      egress: { ...this.#state.egress, stale: !egressFresh },
    }
  }

  /** Kick a refresh when data is stale; never throws, never blocks the caller. */
  maybeRefresh({ ready }) {
    if (!ready) {
      this.#state.latency = { ...this.#state.latency, state: 'skipped' }
      this.#state.egress = { ...this.#state.egress, state: 'skipped' }
      return
    }
    const now = Date.now()
    if (this.#state.latency.at === null || now - this.#state.latency.at >= this.#latencyTtlMs) {
      if (this.#latencyFlight === null) {
        this.#latencyFlight = this.#probeLatency()
          .catch(() => {})
          .finally(() => {
            this.#latencyFlight = null
          })
      }
    }
    if (this.#state.egress.at === null || now - this.#state.egress.at >= this.#egressTtlMs) {
      if (this.#egressFlight === null) {
        this.#egressFlight = this.#probeEgress()
          .catch(() => {})
          .finally(() => {
            this.#egressFlight = null
          })
      }
    }
  }

  async #probeLatency() {
    const started = Date.now()
    const result = await this.#getThroughProxy(this.#latencyUrl, this.#latencyTimeoutMs)
    const ms = Date.now() - started
    if (result.status >= 200 && result.status < 400) {
      this.#state.latency = { ms, at: Date.now(), state: 'ok' }
      this.#logger?.info?.(`延迟探测：${ms}ms（${this.#latencyUrl}）`)
    } else {
      this.#state.latency = { ms: null, at: Date.now(), state: 'error' }
      this.#logger?.warn?.(`延迟探测失败：${result.error ?? result.status}`)
    }
  }

  async #probeEgress() {
    const result = await this.#getThroughProxy(this.#egressUrl, this.#egressTimeoutMs)
    if (result.status >= 200 && result.status < 300) {
      try {
        const data = JSON.parse(result.body)
        if (data && data.query) {
          this.#state.egress = { ip: data.query, country: data.countryCode ?? data.country ?? null, at: Date.now(), state: 'ok' }
          this.#logger?.info?.(`出口 IP：${data.query}${data.countryCode ? ` (${data.countryCode})` : ''}`)
          return
        }
      } catch {
        // fall through to error state
      }
    }
    this.#state.egress = { ip: null, country: null, at: Date.now(), state: 'error' }
    this.#logger?.warn?.(`出口 IP 探测失败：${result.error ?? result.status}`)
  }

  #getThroughProxy(url, timeoutMs) {
    return new Promise((resolve) => {
      let target
      try {
        target = new URL(url)
      } catch (error) {
        resolve({ status: 0, body: '', error: String(error) })
        return
      }
      const request = http.request(
        {
          host: this.#host,
          port: this.#port,
          method: 'GET',
          path: target.href,
          headers: { host: target.host, connection: 'close' },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          )
        },
      )
      request.on('timeout', () => {
        request.destroy(new Error('timeout'))
        resolve({ status: 0, body: '', error: 'timeout' })
      })
      request.on('error', (error) => resolve({ status: 0, body: '', error: error.code ?? error.message }))
      request.end()
    })
  }
}
