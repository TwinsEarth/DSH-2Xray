import http2 from 'node:http2'

export class GrpcError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GrpcError'
    this.code = String(code)
  }
}

/** gRPC frames every message with a one-byte compression flag and a uint32 length. */
function frame(message) {
  const prefix = Buffer.alloc(5)
  prefix.writeUInt8(0, 0)
  prefix.writeUInt32BE(message.length, 1)
  return Buffer.concat([prefix, message])
}

function unframe(buffer) {
  if (buffer.length < 5) throw new GrpcError('INTERNAL', 'gRPC response body shorter than its 5-byte frame header')
  const length = buffer.readUInt32BE(1)
  const end = 5 + length
  if (end > buffer.length) throw new GrpcError('INTERNAL', 'gRPC response frame length exceeds the body')
  return buffer.subarray(5, end)
}

function decodeGrpcMessage(raw) {
  if (raw === undefined) return ''
  try {
    return decodeURIComponent(String(raw))
  } catch {
    return String(raw)
  }
}

/**
 * One unary gRPC call over plaintext HTTP/2 (h2c), which is what Xray's API
 * inbound speaks. No TLS, no compression, no streaming.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path - e.g. `/xray.app.stats.command.StatsService/QueryStats`
 * @param {Buffer} options.message - protobuf request body
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Buffer>} protobuf response body
 */
export function grpcUnary({ host = '127.0.0.1', port, path, message, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let client
    let timer

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        client?.close()
      } catch {
        // already closed
      }
      if (error) reject(error)
      else resolve(value)
    }

    timer = setTimeout(() => {
      finish(new GrpcError('DEADLINE_EXCEEDED', `gRPC ${path} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      client = http2.connect(`http://${host}:${port}`)
    } catch (error) {
      finish(error)
      return
    }
    client.on('error', (error) => finish(new GrpcError(error.code ?? 'UNAVAILABLE', error.message)))

    let request
    try {
      request = client.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-accept-encoding': 'identity',
      })
    } catch (error) {
      finish(error)
      return
    }

    let grpcStatus
    let grpcMessage
    const chunks = []

    request.on('response', (headers) => {
      if (headers['grpc-status'] !== undefined) grpcStatus = headers['grpc-status']
      if (headers['grpc-message'] !== undefined) grpcMessage = headers['grpc-message']
    })
    request.on('trailers', (trailers) => {
      if (trailers['grpc-status'] !== undefined) grpcStatus = trailers['grpc-status']
      if (trailers['grpc-message'] !== undefined) grpcMessage = trailers['grpc-message']
    })
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('error', (error) => finish(new GrpcError(error.code ?? 'UNAVAILABLE', error.message)))
    request.on('end', () => {
      if (grpcStatus !== undefined && Number(grpcStatus) !== 0) {
        finish(new GrpcError(grpcStatus, decodeGrpcMessage(grpcMessage) || `gRPC status ${grpcStatus}`))
        return
      }
      try {
        finish(undefined, unframe(Buffer.concat(chunks)))
      } catch (error) {
        finish(error)
      }
    })

    request.end(frame(message))
  })
}
