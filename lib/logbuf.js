/** Bounded in-memory log ring served to the panel over the authenticated API. */
export class LogBuffer {
  #items = []
  #capacity
  #seq = 0

  constructor(capacity = 1000) {
    this.#capacity = capacity
  }

  append(level, text) {
    const entry = {
      seq: ++this.#seq,
      ts: Date.now(),
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      text: String(text ?? '').slice(0, 2000),
    }
    this.#items.push(entry)
    if (this.#items.length > this.#capacity) this.#items.splice(0, this.#items.length - this.#capacity)
    return entry
  }

  since(after = 0, limit = 200) {
    const items = this.#items.filter((entry) => entry.seq > after).slice(0, limit)
    return { items, cursor: this.#seq, dropped: this.#seq - this.#capacity > after }
  }
}
