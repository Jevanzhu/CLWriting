/**
 * R51-J-3（五十一轮）：dev-api 端口单源解析。
 *
 * 为什么独立成模块：scripts/dev-api.ts 顶层直接 startServer（模块加载即起服），
 * 测试 import 即副作用；解析逻辑抽到纯模块后才可单测（env 注入 + fatal 注入）。
 *
 * 为什么用独立 env 名（CLW_DEV_API_PORT）而非复用 CLWRITING_PORT：后者是桌面
 * server-main 的端口语义（resolveEnvPort，R39-9），dev server 与桌面端各管各的
 * 端口，互不牵连；校验口径（0–65535 整数、非法 fatal 人话退出）与 R39-9 对齐。
 * 注意：换端口后 Vite dev 代理目标（web-next/vite.config.ts，固定 7878）需同步
 * 改，否则 dev 页面连不上后端——dev-api 的 EADDRINUSE 指引文案据此如实披露。
 */
export const DEV_API_PORT_ENV = 'CLW_DEV_API_PORT'

/** dev-api 缺省端口（与 Vite dev 代理目标一致；偏离即两处同步改）。 */
export const DEV_API_DEFAULT_PORT = 7878

/**
 * env → 端口。未设返回缺省；非法值走 fatal（缺省 console.error + exit 2，
 * 测试注入 fatal 捕获后回落缺省——与 server-boot resolveEnvPort 同契约）。
 */
export function resolveDevApiPort(
  env: Record<string, string | undefined>,
  opts?: { fatal?: (msg: string) => void },
): number {
  const raw = env[DEV_API_PORT_ENV]
  if (raw === undefined) return DEV_API_DEFAULT_PORT
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
    const msg = `环境变量 ${DEV_API_PORT_ENV} 的值「${raw}」不是合法端口号：请传 0–65535 的整数，或删除该变量以使用缺省端口 ${DEV_API_DEFAULT_PORT}`
    if (opts?.fatal) {
      opts.fatal(msg)
      return DEV_API_DEFAULT_PORT
    }
    console.error(msg)
    process.exit(2)
  }
  return n
}
