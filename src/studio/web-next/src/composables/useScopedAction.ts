/**
 * 书域动作守卫单源——「入口捕获书名 → await 后复检 → catch 尾款」三件套 + 函数级在途锁。
 *
 * 判定语义：动作所属的书仍是当前书 = 该书的书会话（useBookSession）仍在册；无在册会话时
 *（未进书窗口/测试直挂组件）回落 liveBook() 的书名比对。
 * liveBook 取值纪律：传本组件判「当前书」的活源（`() => props.bookName` /
 * `() => ws.bookName` / 路由 params 活值），**不传**入口时捕获的快照——冻结参数在切书后恒
 * 等于入口值，复检恒真（死实例假活，见 useRelationGraph 的 :key 依赖注）。
 * failScoped 语义：会话 abort（切书/离书取消本会话在途写请求）的迟到失败一律静默吸收
 *（isAbortError 单源），已切书则丢弃，仍在本书才落错——调用方不再逐点手写两个 if。
 * 在途锁语义：模板 :disabled 只拦渲染后的鼠标主路径，键盘/程序化触发与渲染前同拍双触发仍需
 * 函数级锁；锁不防跨动作并发——动作族需互斥时用共享锁实例或既有 genBusy 复合判据。
 *
 * 不换装点（换装会放宽判定强度，非等价替换，故保留现状）：路由 armed 双门族（风格四卡）的
 * armed 是**路由即时判定**，比会话同一性更早——路由已提交而 enterBook 尚未建新会话的窄窗里
 * stillIn 会判真；store 层守卫（stores/doc.ts 等）判定源是该 store 自己的 bookName（与缓存
 * 清空同点原子推进），在 store 内自比自无意义；同类双门（ForeshadowPanel/AnalysisPanel/
 * HistoryPanel/CheckPanel 的 `props.bookName !== book || doc.bookName !== book`）第二门覆盖
 * store 滞留窗。
 * 用法（三件套 + 在途锁的调用形态）见 useChapterTreeActions 的 stillIn/failScoped；
 * 多 await 的动作（逐点都要复检 + catch 尾款 + 锁进出）走本档的 useBookActionRunner，
 * 勿再逐点手写三件套。
 */
import { ref, type Ref } from 'vue'
import { isAbortError } from '../api/client'
import { bookSessionFor } from './useBookSession'

/** 书域动作守卫（见文件头注：stillIn 复检 + failScoped 尾款）。
 *  两件为属性式函数声明（非方法简写）——调用方惯用解构（`const { stillIn } = …`），
 *  方法简写会触发 unbound-method 告警且语义上确无 this。 */
export interface ScopedAction {
  /** 仍在 book 书（await 窗口后未切书/未离书）？ */
  stillIn: (book: string) => boolean
  /** catch 尾款单源：会话中止静默吸收，仍在本书才把错误交给 onError。 */
  failScoped: (book: string, e: unknown, onError: () => void) => void
}

export function useScopedAction(liveBook: () => string): ScopedAction {
  const stillIn = (book: string): boolean => {
    const session = bookSessionFor(book)
    return session ? session.stillIn() : liveBook() === book
  }
  const failScoped = (book: string, e: unknown, onError: () => void): void => {
    if (isAbortError(e)) return // 会话 abort：请求已被取消，结果无意义
    if (!stillIn(book)) return // 已切书：本动作的失败不落新书界面
    onError()
  }
  return { stillIn, failScoped }
}

/** 函数级在途锁——Ref<boolean> 上挂 enter/exit：顶层 ref 在模板自动解包，故
 *  `<button :disabled="pending">` 与脚本侧 `pending.value` 读法均与裸 `ref(false)` 逐位一致。 */
export type PendingAction = Ref<boolean> & {
  /** 取锁：成功 true，已有在途笔 false（调用方早退，不得再 exit）。 */
  enter(): boolean
  /** 释放（放 finally——早退路径未取锁，不会误释放他笔）。 */
  exit(): void
}

export function usePendingAction(): PendingAction {
  const active = ref(false) as PendingAction
  active.enter = () => {
    if (active.value) return false
    active.value = true
    return true
  }
  active.exit = () => {
    active.value = false
  }
  return active
}

/** 切书终止哨兵：守卫步内请求落定后所属书已不在册——抛出以中断动作体剩余语句。
 *  继承 Error 而非裸对象：lint 门的 only-throw-error 只放行 Error 实例；name 取本档
 *  独有词，与 isAbortError 判定面（'AbortError'）不相交——本哨兵是「本动作作废」，
 *  不是请求失败，绝不进错误面。class 而非单例常量：跨 await 抛出的异常须可判身份。 */
class BookAbandoned extends Error {
  constructor() {
    super('book scoped action abandoned')
    this.name = 'BookAbandoned'
  }
}

/** 动作体的调用面（执行器单点提供，体不得越出面上的两个入口造 await）。 */
export interface BookActionCtx {
  /** 入口捕获的书名（发请求只用它）。体里改读活源（props.bookName 一类）即绕开入口
   *  捕获——请求会发到切换后的书，属漏配形态。 */
  readonly book: string
  /** 守卫步：体内**每个** await 都必须经它（裸 await 是漏配形态）。请求落定后所属书
   *  已不在册即抛切书哨兵，体剩余语句（含一切副作用与提示）不再执行；仍在本书则原样返回。 */
  step: <R>(run: () => Promise<R>) => Promise<R>
}

/** 动作声明：差异项全部显式列出（缺省 = 本动作无该项），动作体只写本动作特有编排。 */
export interface BookActionSpec {
  /** 在途锁：取不到锁即早退（体不执行，也不释放他笔的锁）。 */
  pending?: PendingAction
  /** 入口清错误条（`err.value = null` 一族）——只在此显式声明，缺省保留旧错误条。 */
  clearError?: () => void
  /** 动作体：await 一律经 ctx.step；不得自设 try/catch（catch 尾款归执行器）。 */
  body: (ctx: BookActionCtx) => Promise<void>
  /** 失败面（必填，防漏配后静默吞错）：已过 failScoped——会话中止与已切书的迟到失败
   *  都不进这里，落到这里的失败其所属书仍是当前书。 */
  onError: (e: unknown) => void
}

export interface BookActionRunner {
  /** 执行一次书域动作：入口捕获 → 取锁（可选）→ 清错误条（可选）→ 体 → catch 尾款 → 放锁。
   *  返回 promise 恒 resolve（失败已由 onError 面消费），调用方可 `void` 亦可 await。 */
  run(spec: BookActionSpec): Promise<void>
}

/** 书域动作执行器（高阶包装）：把「入口捕获书名 → await 后复检 → 失败提示 → 在途锁进出」
 *  四点收成单点，动作侧无从绕过——
 *  - 复检由守卫步承担：体里每个 await 都走 step，请求落定即查会话，切书后体剩余语句
 *    （提示/落态/开 tab 全在体尾）一律不执行；
 *  - 尾款由本函数承担：体里抛错（含非 Error 值）一律经 failScoped（AbortError 与已切书
 *    静默吸收）后才交 onError，体不写 catch——即便体里漏用 step 裸 await，失败面仍受本
 *    件守卫（漏的只会是成功路径的体尾副作用）；
 *  - 锁由本函数承担：取锁失败即整段早退，放锁在 finally，体抛错也不会漏放。
 *  liveBook 取值纪律同 useScopedAction（传活源，不传入口快照）。 */
export function useBookActionRunner(liveBook: () => string): BookActionRunner {
  const { stillIn, failScoped } = useScopedAction(liveBook)
  return {
    async run(spec: BookActionSpec): Promise<void> {
      if (spec.pending && !spec.pending.enter()) return
      const book = liveBook() // 入口捕获：活源只在此取一次，体内只用 ctx.book
      spec.clearError?.()
      try {
        await spec.body({
          book,
          step: async (run) => {
            const r = await run()
            if (!stillIn(book)) throw new BookAbandoned()
            return r
          },
        })
      } catch (e) {
        if (!(e instanceof BookAbandoned)) failScoped(book, e, () => spec.onError(e))
      } finally {
        spec.pending?.exit()
      }
    },
  }
}
