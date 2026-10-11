import { watch } from 'vue'

/**
 * 切书作用域单源——「bookName 变化 → 清残留（reset）→ 重载（load）」样板的收敛件。
 *
 * 本仓切书有两条轨，本件是「手写 watch 轨」的收敛，不与另一轨互相替代：
 * - 手写 watch 轨（本件换装面）：面板/视图常驻不重建，靠 watch 清本地残留 + 重载；
 * - `:key` 重建轨（保持不变）：Book.vue 对 OverviewView/RelationsView/LearnView/StyleView/
 *   AuditView/OnboardView 挂 `:key=bookName` 整实例拆建——粗粒度兜底，语义是「实例拆建」
 *   而非「清残留 + 重载」，本地 ref 与编辑态一并消灭。
 *
 * 语义（与各面板原手写 watch 逐位等价）：
 * - 触发 = name() 值变化（watch 默认 Object.is 比较）；`immediate` 时挂载即跑一轮。
 * - reset 只在「旧值存在且与新值不同」时执行：immediate 首跑 old 为 undefined（无旧态
 *   可清），对齐 ChapterTreePanel 原显式守卫 `old !== undefined && old !== name`；非
 *   immediate 的首跑 old 已是初值（Vue 对 getter 源的既定行为），故真切书当轮 reset 照跑。
 * - load 每轮都跑（含 immediate 首跑与脏路由 name=''）；空书名的处置留在 load 内——各
 *   面板口径不同（清树 / 直接返回 / 清错误后返回），不收进本件，避免造「统一口径」假象。
 * - reset 先于 load（原手写顺序：先清残留再拉新书）。
 *
 * 不换装点（保留原手写写法，理由随点）：
 * - 多源 watch：HistoryPanel 的 `[ws.activeDocId, props.bookName, savedAt]`——源不止书名。
 * - 设置弹窗族（SettingsBook / SettingsBookAnalysis / SettingsBookRetention /
 *   SettingsBookWriting）：源是 `[ui.settingsOpen, ws.bookName]`，且 open=false 分支语义是
 *   「关窗不做事」，非切书样板。
 * - useSse / useBookSwitchGuard / useChatComposer 的 watch：源带连接/dispatch/草稿语义，
 *   不是「清残留 + 重载」形态。
 * 用法：`useBookScoped(() => props.bookName, { load, reset, immediate: true })`。
 */
export interface BookScopedOptions {
  /** 书名变化后的重载（收新书名；空书名由 load 自行处置） */
  load?: (name: string) => void | Promise<void>
  /** 切书前清残留（旧书态不带进新书）；缺省 = 无残留可清 */
  reset?: () => void
  /** true = 挂载即跑一轮（对齐面板原 `{ immediate: true }`）；缺省 false */
  immediate?: boolean
}

export function useBookScoped(name: () => string, opts: BookScopedOptions): void {
  watch(
    name,
    (n, old) => {
      if (old !== undefined && old !== n) opts.reset?.()
      if (opts.load) void opts.load(n)
    },
    { immediate: opts.immediate ?? false },
  )
}
