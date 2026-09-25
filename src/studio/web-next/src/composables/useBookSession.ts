/**
 * R0916-7-P3-20（评审 P3-20）：书会话单源——「进书」是一个有生命周期的对象。
 *
 * 症结（评审原文）：此前「书会话」没有独立生命周期对象，隔离迟到结果的责任落在每个异步
 * 动作身上——每次 await 后手写 `if (bookName !== book) return`；取消能力（AbortSignal）
 * 写好了却没有接到切书上。本模块把它收敛成一个对象：
 *
 *   BookSession { name, signal, stillIn() }
 *
 * - 进书创建（beginBookSession）、离书/切书 abort（endBookSession / 下一个 begin 顶替）；
 * - signal 由 api/client 按「本书 + 文档结构写」接驳（setBookSessionSignal 注），
 *   离书后旧书在途写请求以 AbortError 收口；
 * - stillIn() 是**会话同一性**判定（active === 本会话记录），不是书名比对：会话快照一旦
 *   作废（离书/切书顶替/同名重进）就恒假，不可复活。旧写法 `bookName !== book` 只在
 *   书名面上判等，同名重进的回环里「上一段会话」与「这一段会话」无从区分——持快照的
 *   消费方（如 BookSession 的持有者）用 stillIn() 才能表达「本会话是否还是那一段」。
 *   注意区分两个入口：currentBookSession()/bookSessionFor(name) 解析的是**当前在册**
 *   会话（动作入口按书名归属取会话用它，语义 = 「本动作所属的书仍是当前书」）。
 *   调用方（useChapterTreeActions 的 stillIn/failScoped）以它替代散写的书名复检。
 *
 * 生命周期纪律（为什么 abort 不早于冲刷）：abort 只发生在**旧会话的工作已落定**之后——
 * 原地切书由路由提交前的守卫先完成冲刷与决断（useBookSwitchGuard），提交后进书才
 * beginBookSession(新书)（此时 abort 旧会话）；离书到脏路由在 flushDirty 落定后
 * endBookSession()。故切书不会打断冲刷途中的保存请求（PUT 面本就不接驳，双保险）。
 * 组件卸载**不** abort：关窗/卸载路径的 flushBeforeClose（useUnloadFlush）在途保存不得
 * 被打断，渲染进程销毁时模块随之释放，无需收尾。
 *
 * 单例面：一个渲染进程同一时刻只有一本在册书（多窗口各自一份模块实例，与 client.ts 的
 * token 同口径），故模块级单例成立；不参与 Vue 响应式（UI 需要的书名源仍是路由）。
 */
import { setBookSessionSignal } from '../api/client'

/** 一本书的在册会话句柄（进书创建，离书/切书后作废）。 */
export interface BookSession {
  /** 会话书名（= 进书时的路由书名；离书后不变，供请求归属与日志用）。 */
  readonly name: string
  /** 会话信号：离书/切书 abort（下一个会话顶替时同样 abort 本会话）。 */
  readonly signal: AbortSignal
  /** 本会话是否仍是在册会话（同步判定；会话作废后恒假，不可复活）。 */
  stillIn(): boolean
}

/** 在册会话记录——active 的引用同一性即「会话仍有效」的唯一判据。 */
let active: { name: string; ctrl: AbortController } | null = null

function sessionOf(rec: { name: string; ctrl: AbortController }): BookSession {
  return {
    name: rec.name,
    signal: rec.ctrl.signal,
    stillIn: () => active === rec,
  }
}

/** 当前在册会话（未进书/已离书为 null）。 */
export function currentBookSession(): BookSession | null {
  return active ? sessionOf(active) : null
}

/** 该书名的在册会话；书名不符（或未进书）返回 null——动作入口用它取本动作的会话，
 *  取不到即「本动作所属的书已不在册」（调用方可回落书名复检，语义等价旧判定）。 */
export function bookSessionFor(name: string): BookSession | null {
  return active && active.name === name ? sessionOf(active) : null
}

/** 进书：建会话并登记信号接驳（同名也重建——重进是一段新会话，旧会话快照随之作废）。
 *  空书名 = 离书（等价 endBookSession）。返回新会话（空书名返回 null）。 */
export function beginBookSession(name: string): BookSession | null {
  if (!name) {
    endBookSession()
    return null
  }
  closeActive()
  const ctrl = new AbortController()
  active = { name, ctrl }
  setBookSessionSignal(name, ctrl.signal)
  return sessionOf(active)
}

/** 离书：作废在册会话并 abort 其信号（调用前提 = 本会话的工作已落定，见文件头注）。 */
export function endBookSession(): void {
  closeActive()
}

/** 作废在册会话唯一出口：先摘 client 接驳再 abort（顺序反了会给「摘除前的并发新请求」
 *  一枚已中止的信号——client 侧另有 aborted 兜底，此处不依赖兜底）。 */
function closeActive(): void {
  if (!active) return
  const ctrl = active.ctrl
  active = null
  setBookSessionSignal('', null)
  ctrl.abort()
}
