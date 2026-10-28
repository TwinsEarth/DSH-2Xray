import test from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import {
  decodeBalancerInfo,
  decodeQueryStats,
  encodeGetBalancerInfo,
  encodeMessageField,
  encodeOverrideBalancer,
  encodeQueryStats,
  encodeStringField,
  encodeVarint,
} from '../lib/control/protobuf.js'
import { GrpcError, grpcUnary } from '../lib/control/grpc.js'
import { ControlClient } from '../lib/control/client.js'

function frame(payload) {
  const prefix = Buffer.alloc(5)
  prefix.writeUInt8(0, 0)
  prefix.writeUInt32BE(payload.length, 1)
  return Buffer.concat([prefix, payload])
}

function statBytes(name, value) {
  return Buffer.concat([encodeStringField(1, name), Buffer.concat([encodeVarint((2 << 3) | 0), encodeVarint(value)])])
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('varint and string fields use the expected wire bytes', () => {
  assert.deepEqual([...encodeVarint(0)], [0])
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02])
  const bytes = encodeOverrideBalancer({ balancerTag: 'active', target: 'proxy-hk' })
  assert.deepEqual([...bytes], [
    0x0a, 0x06, ...Buffer.from('active'),
    0x12, 0x08, ...Buffer.from('proxy-hk'),
  ])
})

test('QueryStats request carries repeated patterns and reset', () => {
  const bytes = encodeQueryStats({ patterns: ['outbound>>>', 'inbound>>>'], reset: true })
  const expected = Buffer.concat([
    encodeStringField(1, 'outbound>>>'),
    encodeStringField(1, 'inbound>>>'),
    Buffer.from([0x10, 0x01]),
  ])
  assert.deepEqual([...bytes], [...expected])
})

test('QueryStats response decodes name/value pairs', () => {
  const statA = statBytes('outbound>>>proxy-hk>>>traffic>>>uplink', 1234)
  const statB = statBytes('outbound>>>proxy-hk>>>traffic>>>downlink', 99)
  const response = Buffer.concat([encodeMessageField(1, statA), encodeMessageField(1, statB)])
  assert.deepEqual(decodeQueryStats(response), [
    { name: 'outbound>>>proxy-hk>>>traffic>>>uplink', value: 1234 },
    { name: 'outbound>>>proxy-hk>>>traffic>>>downlink', value: 99 },
  ])
})

test('balancer info decodes the pinned override target', () => {
  const overrideInfo = Buffer.concat([encodeStringField(2, 'proxy-hk')])
  const balancer = encodeMessageField(5, overrideInfo)
  const response = encodeMessageField(1, balancer)
  assert.deepEqual(decodeBalancerInfo(response), { overrideTarget: 'proxy-hk', principleTargets: [] })
})

test('GetBalancerInfo request is a single tag field', () => {
  assert.deepEqual([...encodeGetBalancerInfo({ tag: 'active' })], [0x0a, 0x06, ...Buffer.from('active')])
})

async function withMockGrpc(handler, run) {
  const server = http2.createServer()
  const requests = []
  server.on('stream', (stream, headers) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ path: headers[':path'], contentType: headers['content-type'], body })
      handler(stream, headers, body)
    })
  })
  const port = await listen(server)
  try {
    await run({ port, requests })
  } finally {
    server.close()
  }
}

test('grpcUnary speaks unary gRPC over h2c', async () => {
  const payload = Buffer.concat([encodeStringField(2, 'proxy-hk')])
  const wrapper = encodeMessageField(1, encodeMessageField(5, payload))
  await withMockGrpc(
    (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
      stream.end(frame(wrapper))
    },
    async ({ port, requests }) => {
      const request = Buffer.from([0x0a, 0x06, ...Buffer.from('active')])
      const response = await grpcUnary({
        port,
        path: '/xray.app.router.command.RoutingService/GetBalancerInfo',
        message: request,
        timeoutMs: 2000,
      })
      assert.deepEqual([...response], [...wrapper])
      assert.equal(requests.length, 1)
      assert.equal(requests[0].contentType, 'application/grpc')
      assert.equal(requests[0].body.readUInt32BE(1), request.length)
    },
  )
})

test('grpcUnary surfaces a non-zero grpc-status as GrpcError', async () => {
  await withMockGrpc(
    (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '5', 'grpc-message': 'boom' })
      stream.end()
    },
    async ({ port }) => {
      await assert.rejects(
        () => grpcUnary({ port, path: '/x/y', message: Buffer.alloc(0), timeoutMs: 2000 }),
        (error) => error instanceof GrpcError && error.code === '5' && /boom/.test(error.message),
      )
    },
  )
})

test('a connection refusal becomes a readable control error', async () => {
  const client = new ControlClient({ port: 1, timeoutMs: 300 })
  await assert.rejects(() => client.getBalancerInfo())
  const snapshot = client.snapshot()
  assert.equal(snapshot.reachable, false)
  assert.match(snapshot.lastError, /ECONNREFUSED|UNAVAILABLE|ECONNRESET/)
})

test('ControlClient switches the balancer and reads stats', async () => {
  const statsBody = Buffer.concat([
    encodeMessageField(1, statBytes('outbound>>>proxy-hk>>>traffic>>>uplink', 42)),
  ])
  await withMockGrpc(
    (stream, headers) => {
      if (headers[':path'].endsWith('/OverrideBalancerTarget')) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(frame(Buffer.alloc(0)))
      } else if (headers[':path'].endsWith('/QueryStats')) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(frame(statsBody))
      } else {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' })
        stream.end()
      }
    },
    async ({ port }) => {
      const client = new ControlClient({ port, timeoutMs: 2000, balancerTag: 'active' })
      assert.equal(await client.overrideBalancerTarget('proxy-hk'), 'proxy-hk')
      assert.equal(client.snapshot().activeTarget, 'proxy-hk')
      assert.equal(client.snapshot().reachable, true)
      const stats = await client.queryStats({ patterns: ['outbound>>>'] })
      assert.deepEqual(stats, [{ name: 'outbound>>>proxy-hk>>>traffic>>>uplink', value: 42 }])
    },
  )
})
