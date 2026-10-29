/**
 * Settings schema for the host half.
 *
 * Only the fields that should be editable from the Plugins page are declared:
 * Schemastery preserves unknown keys, so `nodes`, `routing`, `noProxy` and the
 * rest of the advanced YAML config pass through untouched.
 *
 * Every editable field is `volatile`: the settings page only writes volatile
 * paths, and a volatile-only change does not remount the plugin fiber. The host
 * logs a "restart required" note; the value lands in the profile patch and is
 * applied on the next DSH start (or plugin reload).
 *
 * Schemastery is a harness package that lives beside the installed plugin; the
 * bare import works there. The fallback keeps local checkouts and tests working
 * by resolving the copy from the active profile.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadSchema() {
  const home = process.env.USERPROFILE ?? process.env.HOME
  const anchors = home
    ? [
        join(home, '.dsh', 'profiles', 'desktop', 'package.json'),
        join(home, '.dsh', 'profiles', 'web', 'package.json'),
      ]
    : []

  // Prefer Node's own resolver: a bare `import()` inside a plugin may be served
  // by the harness module loader, whose table does not necessarily contain a
  // peer package such as Schemastery even though it sits in node_modules.
  const attempts = [
    () => {
      const file = createRequire(import.meta.url).resolve('@deepseek-ai/schemastery')
      return import(pathToFileURL(file).href)
    },
    ...anchors.map((anchor) => () => {
      const file = createRequire(anchor).resolve('@deepseek-ai/schemastery')
      return import(pathToFileURL(file).href)
    }),
    () => import('@deepseek-ai/schemastery'),
  ]

  for (const attempt of attempts) {
    try {
      const module = await attempt()
      const candidate = module?.default ?? module
      if (typeof candidate === 'function' && typeof candidate.object === 'function') return candidate
    } catch {
      // try the next resolution route
    }
  }
  throw new Error('@deepseek-ai/schemastery is not resolvable')
}

const Schema = await loadSchema()

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(false)
    .description('启用 Xray 代理：生成配置、启动子进程并接管全局出口。')
    .volatile(),
  shareLink: Schema.string()
    .default('')
    .description('vless:// 分享链接（二维码里就是这段文本）。支持 security=reality/tls/none。')
    .volatile(),
  binary: Schema.object({
    path: Schema.string()
      .default('')
      .description('xray 可执行文件绝对路径；留空按 插件 bin/ → 数据目录 → PATH 查找。')
      .volatile(),
  }),
  inbound: Schema.object({
    port: Schema.natural()
      .default(20808)
      .description('本地 HTTP 入站端口（DSH 与 web_fetch 都经它出网）。')
      .volatile(),
  }),
  takeover: Schema.string()
    .default('auto')
    .description('auto：已有代理时不覆盖；force：强制接管；off：只启动 xray 不接管。')
    .volatile(),
  functionalProbe: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('启动后经本地入站请求一次 204，验证链路；离线环境可关闭。')
      .volatile(),
  }),
  control: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('启用 gRPC 控制面（多节点切换与流量统计，需 xray 2024-09+）。')
      .volatile(),
  }),
  routing: Schema.object({
    mode: Schema.string()
      .default('global')
      .description('global：全部走代理；cn-direct：国内 IP/域名直连；whitelist：仅白名单走代理。')
      .volatile(),
    whitelist: Schema.array(Schema.string())
      .default(['github.com', 'google.com', 'youtube.com', 'x.com', 'facebook.com'])
      .description('强制走 2Xray 的域名（匹配子域名）。')
      .volatile(),
    blacklist: Schema.array(Schema.string())
      .default(['deepseek.com', 'api.deepseek.com'])
      .description('强制直连的域名（优先于白名单与分流）。')
      .volatile(),
  }),
  updates: Schema.object({
    auto: Schema.boolean()
      .default(false)
      .description('启动时检查 npm 上的新版本并自动安装；重启 DSH 后生效。')
      .volatile(),
  }),
})
