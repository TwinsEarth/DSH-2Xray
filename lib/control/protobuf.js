/**
 * Minimal protobuf wire-format codec for the three Xray control-plane messages
 * this plugin needs. Zero dependencies: shipping @grpc/grpc-js + proto-loader
 * would add a second copy of a large dependency tree to every profile for a
 * handful of string fields.
 *
 * Covered:
 *   xray.app.router.command.OverrideBalancerTargetRequest { string balancerTag = 1; string target = 2 }
 *   xray.app.router.command.GetBalancerInfoRequest  { string tag = 1 }
 *   xray.app.router.command.GetBalancerInfoResponse { BalancerMsg balancer = 1 }
 *   xray.app.stats.command.QueryStatsRequest  { repeated string patterns = 1; bool reset = 2 }
 *   xray.app.stats.command.QueryStatsResponse { repeated Stat stat = 1 }
 *   xray.app.stats.command.Stat { string name = 1; int64 value = 2 }
 */

export function encodeVarint(value) {
  let n = BigInt(value)
  if (n < 0n) throw new RangeError('protobuf varint must be non-negative')
  const bytes = []
  while (n > 0x7fn) {
    bytes.push(Number(n & 0x7fn) | 0x80)
    n >>= 7n
  }
  bytes.push(Number(n))
  return Buffer.from(bytes)
}

function readVarint(buffer, start) {
  let result = 0n
  let shift = 0n
  let position = start
  for (;;) {
    if (position >= buffer.length) throw new Error('protobuf: truncated varint')
    const byte = buffer[position++]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7n
    if (shift > 70n) throw new Error('protobuf: varint too long')
  }
  return [result, position]
}

function fieldKey(field, wireType) {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wireType))
}

export function encodeStringField(field, value) {
  const bytes = Buffer.from(String(value), 'utf8')
  return Buffer.concat([fieldKey(field, 2), encodeVarint(bytes.length), bytes])
}

export function encodeMessageField(field, bytes) {
  return Buffer.concat([fieldKey(field, 2), encodeVarint(bytes.length), bytes])
}

export function encodeBoolField(field, value) {
  return Buffer.concat([fieldKey(field, 0), encodeVarint(value ? 1 : 0)])
}

/** Decode one message into `{ field, wire, value }` entries (value is BigInt for varints). */
export function decodeFields(buffer) {
  const fields = []
  let position = 0
  while (position < buffer.length) {
    let tag
    ;[tag, position] = readVarint(buffer, position)
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      let value
      ;[value, position] = readVarint(buffer, position)
      fields.push({ field, wire, value })
    } else if (wire === 2) {
      let length
      ;[length, position] = readVarint(buffer, position)
      const end = position + Number(length)
      if (end > buffer.length) throw new Error('protobuf: truncated length-delimited field')
      fields.push({ field, wire, value: buffer.subarray(position, end) })
      position = end
    } else if (wire === 1) {
      position += 8
    } else if (wire === 5) {
      position += 4
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`)
    }
  }
  return fields
}

function stringOf(fields, field) {
  const entry = fields.find((item) => item.field === field && item.wire === 2)
  return entry === undefined ? undefined : entry.value.toString('utf8')
}

function messageOf(fields, field) {
  const entry = fields.find((item) => item.field === field && item.wire === 2)
  return entry === undefined ? undefined : entry.value
}

export function encodeOverrideBalancer({ balancerTag, target }) {
  return Buffer.concat([encodeStringField(1, balancerTag), encodeStringField(2, target)])
}

export function encodeGetBalancerInfo({ tag }) {
  return encodeStringField(1, tag)
}

export function decodeBalancerInfo(buffer) {
  const balancer = messageOf(decodeFields(buffer), 1)
  if (balancer === undefined) return { overrideTarget: undefined, principleTargets: [] }
  const fields = decodeFields(balancer)
  const override = messageOf(fields, 5)
  const principle = messageOf(fields, 6)
  return {
    overrideTarget: override === undefined ? undefined : stringOf(decodeFields(override), 2),
    principleTargets:
      principle === undefined
        ? []
        : decodeFields(principle)
            .filter((item) => item.field === 1 && item.wire === 2)
            .map((item) => item.value.toString('utf8')),
  }
}

export function encodeQueryStats({ patterns = [], reset = false }) {
  const parts = patterns.map((pattern) => encodeStringField(1, pattern))
  if (reset) parts.push(encodeBoolField(2, true))
  return Buffer.concat(parts)
}

export function decodeQueryStats(buffer) {
  const stats = []
  for (const entry of decodeFields(buffer)) {
    if (entry.field !== 1 || entry.wire !== 2) continue
    const fields = decodeFields(entry.value)
    const name = stringOf(fields, 1)
    const value = fields.find((item) => item.field === 2 && item.wire === 0)?.value ?? 0n
    if (name === undefined) continue
    stats.push({ name, value: Number(value) })
  }
  return stats
}
