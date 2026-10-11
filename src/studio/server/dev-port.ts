/**
 * dev-api 端口单源解析。
 *
 * 为什么独立成模块：scripts/dev-api.ts 顶层直接 startServer（模块加载即起服），
 * 测试 import 即副作用；解析逻辑抽到纯模块后才可单测（env 注入 + fatal 注入）。
 *
 * 为什么用独立 env 名（CLW_DEV_API_PORT）而非复用 CLWRITING_PORT：后者是桌面
 * server-main 的端口语义（resolveEnvPort），dev server 与桌面端各自独立管
 * 端口；校验口径（1–65535 整数、非法 fatal 人话退出）骨架与对齐，但 0 的
 * 口径刻意收紧（见 resolveDevApiPort 内注）。
 * 端口值单源：DEV_API_DEFAULT_PORT 声明在跨包契约底座 src/shared/contract/studio.ts
 * （web-next 的 Vite 代理目标与 SSE dev 直连基址消费同一份），本模块只按名再导出——
 * 换端口只改单源一处，三处镜像不再各自手抄。
 */
import { DEV_API_DEFAULT_PORT } from '../../shared/contract/studio.js'

export const DEV_API_PORT_ENV = 'CLW_DEV_API_PORT'

/** dev-api 缺省端口——单源见跨包契约底座，本模块为兼容既有 import 面再导出。 */
export { DEV_API_DEFAULT_PORT }

/**
 * env → 端口。未设返回缺省；非法值（含 0）走 fatal（缺省 console.error + exit 2，
 * 测试注入 fatal 捕获后回落缺省——与 server-boot resolveEnvPort 同契约）。
 */
export function resolveDevApiPort(
  env: Record<string, string | undefined>,
  opts?: { fatal?: (msg: string) => void },
): number {
  const raw = env[DEV_API_PORT_ENV]
  if (raw === undefined) return DEV_API_DEFAULT_PORT
  const n = Number(raw)
  // 清偿 显式拒绝（n < 0 → n < 1）——0 会让 listen 落在随机
  // 端口，而 Vite dev 代理目标取自跨包单源缺省（env 覆盖不会同步过去），dev 页面
  // /api 全部静默失联且无任何提示。选 fail-loud 而非 warn+回落缺省：①与既有非法
  // 值口径同一条 fatal 通道，人话指认 env 名与取值域，改动面最小；②显式设置的值
  // 被静默替换会掩盖误配。桌面端 resolveEnvPort仍允许 0 不受影响——桌面
  // 端 listen 后自发现实际端口，无固定代理前提，0 在彼处合法。
  if (raw.trim() === '' || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
    const msg = `环境变量 ${DEV_API_PORT_ENV} 的值「${raw}」不是合法端口号：请传 1–65535 的整数，或删除该变量以使用缺省端口 ${DEV_API_DEFAULT_PORT}`
    if (opts?.fatal) {
      opts.fatal(msg)
      return DEV_API_DEFAULT_PORT
    }
    console.error(msg)
    process.exit(2)
  }
  return n
}
