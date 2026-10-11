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
 * 用法（三件套 + 在途锁的调用形态）见 useChapterTreeActions 的 stillIn/failScoped 与
 * WorkbenchView 生成族。
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
