import test from 'node:test'
import assert from 'node:assert/strict'
import { LogBuffer } from '../lib/logbuf.js'

test('the log ring pages by cursor and reports the head', () => {
  const ring = new LogBuffer(10)
  ring.append('info', 'one')
  ring.append('warn', 'two')
  const first = ring.since(0)
  assert.equal(first.items.length, 2)
  assert.equal(first.cursor, 2)
  const second = ring.since(first.cursor)
  assert.equal(second.items.length, 0)
  ring.append('error', 'three')
  const third = ring.since(first.cursor)
  assert.deepEqual(third.items.map((entry) => entry.text), ['three'])
})

test('the ring drops the oldest entries at capacity', () => {
  const ring = new LogBuffer(3)
  for (let index = 1; index <= 5; index++) ring.append('info', `line-${index}`)
  const page = ring.since(0)
  assert.deepEqual(page.items.map((entry) => entry.text), ['line-3', 'line-4', 'line-5'])
  assert.equal(page.cursor, 5)
})

test('levels outside the known set fall back to info and text is bounded', () => {
  const ring = new LogBuffer()
  const entry = ring.append('verbose', 'x'.repeat(5000))
  assert.equal(entry.level, 'info')
  assert.equal(entry.text.length, 2000)
})
