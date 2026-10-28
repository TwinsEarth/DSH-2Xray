/** Thin adapter over the cordis logger so tests can run without a context. */
export function createLogger(ctx) {
  const base = ctx?.logger
  const emit = (level, args) => {
    try {
      if (base && typeof base[level] === 'function') base[level](...args)
      else if (level === 'debug') console.log(...args)
      else console[level](...args)
    } catch {
      // a logger failure must never break the plugin
    }
  }
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => emit('debug', args),
    raw: base,
  }
}
