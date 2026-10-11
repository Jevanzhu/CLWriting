import { getConfig, type BookConfig } from '../api/books'

/**
 * 书级配置（book.yaml）读单源缓存——「同书多消费方共享一次请求与一份结果」的收拢件。
 *
 * 动机：进书后编辑器视图、右栏信息面板、专注统计条、设置页各读一次同一份 book.yaml，
 * 各点自拉即同一配置的重复请求；本件让同书并发读取合并在途、已读结果留缓存，
 * 由 workspace store 的 loadBookConfig / invalidateBookConfig 接线（本件不 import stores/*，
 * 保持 shared 层单向：store → shared）。
 *
 * 三个不变式：
 * ① 同书并发读取合并在途（一次请求、多消费者共享）；
 * ② 已读结果留缓存（第二次读不再发请求）；失败不留（无负缓存——下次读取照常重试，
 *    与各消费方「失败即降级/重试」的原语义一致）；
 * ③ 失效只丢缓存不取值：值仍由下次读取向服务端取（跨窗失效通知不携带值）。
 * 缓存对象按书共享且只读——消费方不得原地改写（改一处即污染同书其他消费方）。
 */
export type BookConfigRead = { config: BookConfig; error: null } | { config: null; error: Error }

export interface BookConfigCache {
  /** 读书级配置：缓存命中直接复用；未命中合并同书在途；失败经 error 面返回不抛。 */
  load: (name: string) => Promise<BookConfigRead>
  /** 失效缓存（缺省 = 全部书）：只丢缓存，下次读取重取。 */
  invalidate: (name?: string) => void
}

export function createBookConfigCache(): BookConfigCache {
  const cache = new Map<string, BookConfig>()
  /** 在途台账（name → promise；words.ensureBaseline 手法）。 */
  const inflight = new Map<string, Promise<BookConfigRead>>()
  /** 每书失效代数：读取发起后配置被失效（写入/他窗广播）时，迟到响应不回填缓存。 */
  const gen = new Map<string, number>()

  function load(name: string): Promise<BookConfigRead> {
    const cached = cache.get(name)
    if (cached) return Promise.resolve({ config: cached, error: null })
    const running = inflight.get(name)
    if (running) return running
    // 请求装配期的同步抛错（api 面被替身/装配异常）同样落 error 面：
    // 「失败经 error 面返回不抛」这条对全部失败形态成立，消费方无需在 await 外再套 catch
    let req: Promise<BookConfig>
    try {
      req = getConfig(name)
    } catch (e) {
      return Promise.resolve({ config: null, error: e instanceof Error ? e : new Error(String(e)) })
    }
    const cur = gen.get(name) ?? 0
    /** 落定即身份删键（words.ts 口径）：失效清台账后旧 promise 落定不得误删新登记。 */
    const settle = (): void => {
      if (inflight.get(name) === p) inflight.delete(name)
    }
    // 单跳 then（成功/失败两臂同点）：调用方 await 的恢复时机与直调 api 同拍，
    // 不给既有消费方多加一拍延迟（判断链上的时序断言不受影响）
    const p = req.then(
      (config): BookConfigRead => {
        settle()
        // 读取期间失效（配置刚被改写）→ 迟到响应不回填缓存，本次仍把值交给调用方
        if ((gen.get(name) ?? 0) === cur) cache.set(name, config)
        return { config, error: null }
      },
      (e: unknown): BookConfigRead => {
        settle()
        // 非 Error 拒绝包成 Error：error 面类型收窄，friendlyError 仍按原消息归类
        return { config: null, error: e instanceof Error ? e : new Error(String(e)) }
      },
    )
    inflight.set(name, p)
    return p
  }

  function invalidate(name?: string): void {
    const names = name === undefined ? [...cache.keys(), ...inflight.keys()] : [name]
    for (const n of names) {
      gen.set(n, (gen.get(n) ?? 0) + 1)
      cache.delete(n)
      inflight.delete(n)
    }
  }

  return { load, invalidate }
}
