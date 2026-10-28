import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const COLLECT_BYTES = 64 * 1024

/**
 * Resolve the subprocess service without tripping Cordis' inject guard.
 *
 * Reading `ctx.subprocess` directly throws
 * `cannot get property "subprocess" without inject` on a fiber that did not
 * declare it; `ctx.get(name)` is the reflective lookup and returns undefined
 * instead. The service stays optional because a profile without
 * `dsh-subprocess-local` still gets the `child_process` fallback.
 */
function resolveSubprocess(ctx) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('subprocess')
      if (service) return service
    }
  } catch {
    // inactive or guarded context: fall through to the fallback launcher
  }
  return undefined
}

/**
 * A launcher hides whether the child runs through `ctx.subprocess` (Windows Job
 * Object, process-tree containment, DSH's environment scrub) or through a bare
 * `child_process` fallback for compositions without the service.
 *
 * Every returned handle has the same small surface:
 *   done: Promise<{ exitCode, signal, error? }>
 *   stderrTail(): string
 *   terminate(): Promise<void>
 *   waitForExit(): Promise<void>
 *   pid?: number
 */
export function createLauncher(ctx, { logger } = {}) {
  const service = resolveSubprocess(ctx)
  if (service && typeof service.spawn === 'function' && typeof service.resolveExecutable === 'function') {
    return createServiceLauncher(service)
  }
  logger?.warn?.('ctx.subprocess 不可用，退化为 child_process 启动；Windows 上将无法保证 Job Object 级别的进程树清理')
  return createNodeLauncher()
}

/**
 * Resolve the launcher lazily at first spawn instead of at activation: the
 * subprocess provider may mount after this plugin's fiber, and a strict
 * `inject` dependency would stop the plugin from activating at all.
 */
export function createLazyLauncher(ctx, options) {
  let inner
  const resolve = () => (inner ??= createLauncher(ctx, options))
  return {
    get kind() {
      return resolve().kind
    },
    resolveExecutable(command, env, signal) {
      return resolve().resolveExecutable(command, env, signal)
    },
    spawn(spec) {
      return resolve().spawn(spec)
    },
  }
}

function createServiceLauncher(service) {
  return {
    kind: 'ctx.subprocess',
    resolveExecutable(command) {
      return service.resolveExecutable(command, process.env, undefined)
    },
    spawn({ argv, cwd, graceMs, env }) {
      const handle = service.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: COLLECT_BYTES },
          stderr: { maxBytes: COLLECT_BYTES },
        },
        graceMs,
        env,
      })
      const done = Promise.resolve(handle.done).then(
        (outcome) => ({ exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null }),
        (error) => ({ exitCode: null, signal: null, error }),
      )
      const readTail = (which) => {
        try {
          return handle.collected?.[which]?.readFrom(0)?.text ?? ''
        } catch {
          return ''
        }
      }
      return {
        kind: 'ctx.subprocess',
        get pid() {
          return typeof handle.pid === 'number' ? handle.pid : undefined
        },
        done,
        stdoutTail: () => readTail('stdout'),
        stderrTail: () => readTail('stderr'),
        terminate() {
          return Promise.resolve(handle.terminate()).catch(() => {})
        },
        waitForExit() {
          return Promise.resolve(handle.waitForExit()).catch(() => {})
        },
      }
    },
  }
}

function createNodeLauncher() {
  return {
    kind: 'child_process',
    async resolveExecutable(command) {
      return command
    },
    spawn({ argv, cwd, graceMs, env }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      let stdout = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > COLLECT_BYTES) stderr = stderr.slice(-COLLECT_BYTES)
      })
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > COLLECT_BYTES) stdout = stdout.slice(-COLLECT_BYTES)
      })

      let settled = false
      let resolveExit
      const exited = new Promise((resolve) => {
        resolveExit = resolve
      })
      const settle = (value) => {
        if (settled) return
        settled = true
        resolveExit(value)
      }
      child.once('error', (error) => settle({ exitCode: null, signal: null, error }))
      child.once('exit', (code, signal) => settle({ exitCode: code, signal }))

      let terminating
      return {
        kind: 'child_process',
        get pid() {
          return child.pid
        },
        done: exited,
        stdoutTail: () => stdout,
        stderrTail: () => stderr,
        terminate() {
          if (terminating) return terminating
          terminating = (async () => {
            if (child.exitCode !== null || child.signalCode !== null) return
            if (process.platform === 'win32') {
              if (typeof child.pid === 'number') {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
              }
              await Promise.race([exited, delay(1500).then(() => {})])
              return
            }
            try {
              child.kill('SIGTERM')
            } catch {
              // already gone
            }
            const exitedInTime = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)])
            if (!exitedInTime) {
              try {
                child.kill('SIGKILL')
              } catch {
                // already gone
              }
            }
          })()
          return terminating
        },
        waitForExit() {
          return exited.then(() => {})
        },
      }
    },
  }
}
