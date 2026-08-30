/**
 * R77-1（二十五轮批 A）：系统字体列表 TTL 缓存（main 进程侧，降半档）。
 *
 * desktop:get-system-fonts 每次调用都真跑 font-list 的系统命令（mac osascript /
 * win 注册表枚举），百毫秒级且结果在一次会话内基本不变。前端 useSystemFonts 已有
 * 会话级单例缓存，本模块补主进程侧缺口：渲染层重载（设置弹窗重开）/ 第二窗口再次
 * invoke 时的重复系统命令。
 *
 * 语义：TTL 内命中缓存；过期/未缓存真跑 loader；并发调用合并为同一在途 Promise
 * （双窗口同拍拉取只跑一次系统命令）。loader 失败不缓存（无负缓存）——下次调用
 * 重新探测，调用方（main.ts）catch 后返回 [] 的兜底语义不变。
 * ttlMs/now 可注入（测试用，不动生产语义）。
 */
export interface SystemFontCacheOptions {
  /** 缓存存活期；缺省 60s（字体安装属低频事件，60s 内的陈旧可接受）。 */
  ttlMs?: number
  /** 时钟源（测试注入用）。 */
  now?: () => number
}

export function createSystemFontCache(
  load: () => Promise<string[]>,
  opts?: SystemFontCacheOptions,
): () => Promise<string[]> {
  const ttl = opts?.ttlMs ?? 60_000
  const now = opts?.now ?? Date.now
  let cached: string[] | null = null
  let cachedAt = 0
  let inflight: Promise<string[]> | null = null
  return async () => {
    if (cached !== null && now() - cachedAt < ttl) return cached
    if (inflight) return inflight
    inflight = load()
      .then((fonts) => {
        cached = fonts
        cachedAt = now()
        return fonts
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}
