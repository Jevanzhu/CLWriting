/**
 * （Opus-5.5 轮）：编辑器正文回写防抖合并（渲染层输入热路径）。
 *
 * 现场（改前）：CmHost 每次按键 emit 正文串 → 父层 EditorView 在同一同步输入栈内跑
 * mergeFm（全文重拼）+ doc.patch（全等比较）+ body 计算属性重切（splitFrontmatter
 * 一次全文 split('\n')/join 大分配）+ CmHost watch 的全等回比，另加 CmHost 自身
 * 一次 doc.toString——数百 KB～MB 级文档每按键多遍全文拷贝。本模块把「正文串 →
 * store 的合并回写」收敛为**尾随节流**（窗口内多次输入只落一笔，到点取槽内最新串。
 * 手法对齐 shared/dirty-mirror.ts 的节流分档：都是「渲染层高频事件 → 低频全量落点」）：
 * 输入侧只登记 {docId, body} 并（首笔）起窗，到点或被抓冲刷时回调注入的 commit。
 *
 * 不变量（本项风险面，回归测试逐条钉死）：
 *  1. **末次输入不丢**：槽内恒为最新正文，到点落的是它而非起窗时的快照；
 *  2. **切档/卸载/保存/关窗前必须 flush**：防抖窗内的键入不得随切档或关窗消失。
 *     调用点 = EditorView（docId 同步 watch + onUnmounted）、doc store（save/flushDirty
 *     顶部，覆盖 ⌘S/autosave/切书冲刷/flushBeforeClose/改名前置冲刷）、Book.vue
 *     （hasUnsavedWork 刷新守卫）；
 *  2b. **「先读 dirty 再决定落不落盘」的决策点，读之前必须 flush**（附批补账：首版只
 *     列了整链落盘点，这类决策点在窗内读到 dirty=false 就整段放行——既不冲刷也不保存，
 *     随后按盘上缺末段的内容走）。调用点 = 章节结构操作族 flushUnsaved（并入上一章/
 *     撤销并入/光标拆分，读前先落尾）、章节树删除前置落盘、改写基线（服务端读盘）、
 *     切档存旧档（openTab）；
 *  2c. **首笔输入即同步标脏**（质量评审）：内容仍按窗口节流，但条目的 dirty 在
 *     第一笔键入时经注入回调立刻置位——「先读 dirty 再决定」的判定从此不再依赖每个
 *     调用点都记得先冲刷（历史恢复曾因此漏网：窗内读到 dirty=false，报「已恢复」但
 *     编辑器仍是旧稿）。回调由 doc store 注入（markEntryDirty），本模块不反向依赖 store。
 *     标脏是**悲观**的：窗内净编辑为零（键入后又撤销回原文）时脏位仍留到下次保存，
 *     代价至多一次内容等值的写入——换取不引入「反标脏」（会误清他处写者置的脏）。
 *  3. **落点恒按登记时的 docId 解析**：切档后父层 entry 已指向新档，若按「当前 entry」
 *     回写即跨档污染（同型面），故槽存 {docId, body} 原子对、commit 用槽内
 *     docId 取条目。
 *
 * 窗口 200ms：报告建议 100–200ms 档，取上沿——同族展示防抖（/）150ms 与
 * 连续键入的行间隔（约 150–300ms）之间，既真能合并同轮多键、又不让 store 滞后过久。
 * 滞后代价（store 内容最多慢一个窗口）已由上述 flush 点收口到「窗口内进程硬崩」一
 * 种暴露面——与 dirty-mirror 既有取舍（镜像落后编辑 ≤ 一个节流间隔）同型，非新增面。
 *
 * 本模块零依赖（不 import 任何 store/组件）：commit 由视图层注入，故 store 侧可直接
 * import 其 flush 而不形成 store → 视图的反向依赖。
 */

/** 回写执行体（视图层注入：mergeFm + doc.patch；null = 无编辑器在场）。 */
export type BodyWritebackCommit = (docId: string, body: string) => void

/** 首笔标脏回调（doc store 注入：只置 dirty 位，不动内容——内容仍按窗口节流落回）。 */
export type BodyWritebackDirty = (docId: string) => void

/** 防抖窗（ms，尾随）：窗口内多次输入合并为一笔；到点取槽内最新正文。 */
const WRITEBACK_WINDOW_MS = 200

/** 当前回写执行体（EditorView mount 注册 / unmount 注销）。 */
let commit: BodyWritebackCommit | null = null
/** 首笔标脏回调（doc store 注册；null = 未接线，标脏退化为到点随内容落回）。 */
let markDirty: BodyWritebackDirty | null = null
/** 待落回槽（{docId, body} 原子对——见模块头注③）。null = 无待落输入。 */
let pending: { docId: string; body: string } | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** 注册/注销首笔标脏回调（doc store 生命周期：setup 注册）。注销不冲刷——
 *  标脏与内容落回解耦，内容面仍由 flush 收口。 */
export function registerBodyWritebackDirty(fn: BodyWritebackDirty | null): void {
  markDirty = fn
}

/** 注册/注销回写执行体。注销（null）会丢弃未落槽与在途定时器——调用方必须先
 *  flush（EditorView onUnmounted 即「先 flush 再注销」），否则窗口内键入随之丢失。 */
export function registerBodyWriteback(fn: BodyWritebackCommit | null): void {
  commit = fn
  if (fn === null) {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }
}

/** 冲刷防抖尾：立即落回最新正文（幂等，无待落输入即 no-op）。 */
export function flushBodyWriteback(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (pending === null) return
  const { docId, body } = pending
  pending = null
  commit?.(docId, body)
}

/** 登记一笔正文输入（父层 onBodyChange 唯一入口）。返回是否有待落输入（测试用）。 */
export function scheduleBodyWriteback(docId: string, body: string): void {
  // 无编辑器在场（工作台/总览态等）：不登记——无执行体可落，登记只会滞留残槽
  if (commit === null) return
  // 切档窗口：槽内还是上一档的尾巴 → 先按旧档落定，防新档输入覆盖旧档未落正文
  if (pending !== null && pending.docId !== docId) flushBodyWriteback()
  pending = { docId, body }
  // 首笔即标脏（内容仍等窗口到点）：窗口内的「先读 dirty 再决定」不再读到 false
  markDirty?.(docId)
  // 尾随节流：窗口内已有定时器则不重置（到点落的是槽内当时最新的正文）
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    flushBodyWriteback()
  }, WRITEBACK_WINDOW_MS)
}

/** 是否存在窗口内未落回的正文（Book.vue 刷新守卫用：防抖尾不得随刷新静默丢失）。 */
export function hasPendingBodyWriteback(): boolean {
  return pending !== null
}
