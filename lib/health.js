import net from 'node:net'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** One TCP connect attempt; resolves false on error or timeout, never throws. */
export function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(Math.max(50, timeoutMs), () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Sleep that returns early when the signal aborts. */
export async function cancellableDelay(ms, signal) {
  if (!signal) return delay(ms)
  if (signal.aborted) return
  await Promise.race([
    delay(ms),
    new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true })
    }),
  ])
}

/**
 * Poll the inbound port until it accepts a connection or the budget runs out.
 * This is the hard readiness gate: the global dispatcher is never pointed at a
 * port that has not answered a real TCP connect.
 */
export async function waitForPort({ host, port, timeoutMs, intervalMs = 100, signal }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    if (await tcpConnect(host, port, 500)) return true
    await cancellableDelay(intervalMs, signal)
  }
  return false
}

/** Whether a loopback port can be bound right now. */
export function portIsFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Best-effort "who is holding this port" for the `port-busy` diagnostic.
 *
 * A start that loses the port must name the process to release instead of only
 * quoting xray's stderr — the common case on Windows is a leftover xray or the
 * standalone 2Xray helper already listening on 127.0.0.1:20808. Never throws:
 * a missing OS tool or unexpected output degrades to `null`.
 *
 * @param {object} options
 * @param {number} options.port - TCP port to look up.
 * @param {string} [options.host] - reported back unchanged.
 * @param {Function} [options.runner] - `spawnSync`-compatible command runner.
 * @returns {{ pid: number, name: string|null, host: string, port: number }|null}
 */
export function describePortOwner({ port, host = '127.0.0.1', runner = spawnSync } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const run = (command, args) => {
    try {
      return runner(command, args, { encoding: 'utf8', timeout: 1500, windowsHide: true })?.stdout ?? ''
    } catch {
      return ''
    }
  }
  const listeningLine = (text) =>
    String(text)
      .split(/\r?\n/)
      .find((line) => new RegExp(`(?:\\[|:|\\])${port}(?:\\s|$)`).test(line) && /LISTEN/i.test(line))

  if (process.platform === 'win32') {
    const line = listeningLine(run('netstat', ['-ano', '-p', 'tcp']))
    if (!line) return null
    const pid = Number(line.trim().split(/\s+/).pop())
    if (!Number.isInteger(pid) || pid <= 0) return null
    const csv = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    const name = /^"([^"]+)"/m.exec(csv)?.[1] ?? null
    return { pid, name, host, port }
  }

  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
  const lsofPid = Number(/^p(\d+)$/m.exec(lsof)?.[1])
  if (Number.isInteger(lsofPid) && lsofPid > 0) {
    return { pid: lsofPid, name: /^c(.+)$/m.exec(lsof)?.[1] ?? null, host, port }
  }
  const ss = run('ss', ['-ltnp', `sport = :${port}`])
  const ssPid = Number(/pid=(\d+)/.exec(ss)?.[1])
  if (Number.isInteger(ssPid) && ssPid > 0) {
    return { pid: ssPid, name: /users:\(\("([^"]+)"/.exec(ss)?.[1] ?? null, host, port }
  }
  return null
}

/**
 * End-to-end probe: ask the local inbound for a small URL through the proxy
 * and require a non-error status. This is the only check that proves the
 * upstream (uuid / flow / SNI / shortId / key) actually works; a TCP connect
 * alone only proves the inbound is listening.
 *
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export function httpProxyProbe({ host, port, url, timeoutMs }) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      resolve({ ok: false, error: `invalid probe url: ${String(error)}` })
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = http.request(
      {
        host,
        port,
        method: 'GET',
        // Absolute-form request line: the HTTP inbound proxies this.
        path: target.href,
        headers: { host: target.host, connection: 'close' },
        timeout: timeoutMs,
      },
      (response) => {
        response.resume()
        const status = response.statusCode ?? 0
        finish({ ok: status >= 200 && status < 400, status })
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('probe timeout'))
      finish({ ok: false, error: 'timeout' })
    })
    request.on('error', (error) => {
      finish({ ok: false, error: error?.code ?? error?.message ?? 'request failed' })
    })
    request.end()
  })
}
