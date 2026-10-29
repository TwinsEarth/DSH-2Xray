import http from 'node:http'
import https from 'node:https'

/**
 * Direct HTTP(S) GET that never uses the global undici dispatcher.
 *
 * Plugin self-update and geodata refresh must not depend on the tunnel they are
 * configuring: when the proxy is down or flaky, using global fetch would make
 * the fix unreachable. Redirects are followed manually.
 */
export function getBuffer(url, { timeoutMs = 60_000, maxRedirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (target, remaining) => {
      let parsed
      try {
        parsed = new URL(target)
      } catch (error) {
        reject(error)
        return
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error(`unsupported protocol: ${parsed.protocol}`))
        return
      }
      const transport = parsed.protocol === 'https:' ? https : http
      const request = transport.get(
        parsed,
        { headers: { 'user-agent': 'dsh-2xray-updater', accept: '*/*', ...headers } },
        (response) => {
          const location = response.headers.location
          if (location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && remaining > 0) {
            response.resume()
            attempt(new URL(location, parsed).href, remaining - 1)
            return
          }
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
        },
      )
      request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')))
      request.on('error', reject)
    }
    attempt(url, maxRedirects)
  })
}
