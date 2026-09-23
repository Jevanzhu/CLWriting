/**
 * RC 源码重审 B-5（Opus-5.5 轮）：关窗/刷新/卸载冲刷链路独立成 composable。
 *
 * 为什么独立：这是 Book.vue 里三条各有沿革的兜底路径——①关窗（主进程 close 拦截经
 * executeJavaScript 调 window.__clwFlushBeforeClose，含书级 prefs 先冲刷）②刷新/导航
 * （beforeunload preventDefault → 异步 flushDirty → 落净后带一次性标记重放，含 R71-6
 * 冲突守卫）③卸载（onUnmounted fire-and-forget flush + 失败/冲突留痕）。三者共享
 * 「什么算未保存工作」（hasUnsavedWork）与同一批 doc/workspace store 出口，写成页面
 * setup 顶层时清理链（监听/全局钩子注销）与业务分支混在一处，是最容易漏项的一类改动面
 * （本仓反复加固过：R44-2 / R44-19 / R71-6 / R37-1 / F1 / B-2 防抖尾并入）。
 *
 * 生命周期（成对清理，逐条对齐迁移前）：onMounted 挂 beforeunload 监听 + 注册全局
 * 钩子；onUnmounted 摘监听 + 删全局钩子 + fire-and-forget flushDirty 留痕——注册与
 * 注销同文件相邻，漏项不可能只改一边。
 *
 * 语义零变化：本文件是 Book.vue 原关窗/刷新块与卸载冲刷块的逐行搬迁（各 R 编号沿革
 * 注释随迁），差异仅各 store 在本函数内取实例。
 */
import { onMounted, onUnmounted } from 'vue'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { hasPendingBodyWriteback } from '../shared/body-writeback'

/** 注册关窗/刷新/卸载三条冲刷链（随组件实例挂载注册、卸载注销）。 */
export function useUnloadFlush(): void {
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const ui = useUiStore()

  // R44-2（四十四轮）：关窗/刷新兜底改双路。①关窗：主进程在 close 拦截后经
  // executeJavaScript 调 window.__clwFlushBeforeClose（页面未死，异步保存链全通），
  // 落定/短超时后 destroy——Chromium ≥M80 在页面卸载路径整体禁同步 XHR，原渲染层
  // 同步 XHR 兜底经双 Electron 实验实证零字节到达（四十四轮报告 §3.1），已删。
  // ②刷新/导航：beforeunload preventDefault 挡下（页面未死）→ 异步 flushDirty →
  // 全部落净后带一次性标记重放刷新；未落净（保存失败/冲突未决）不自动重放，toast
  // 告知后由作者处理（R71-6 冲突守卫并入本监听；R44-19：Electron 不渲染浏览器
  // Leave-site 确认框，静默挡下＝无反馈死刷新）。纯浏览器形态下关窗走原生确认，
  // 确认离开时 flush 未竟部分有丢失窗口——生产形态是 Electron 壳，关窗由①负责。
  const RELOAD_FLUSH_FLAG = 'clw:reload-after-flush'
  function consumeFreshReloadFlag(): boolean {
    const v = sessionStorage.getItem(RELOAD_FLUSH_FLAG)
    if (v === null) return false
    sessionStorage.removeItem(RELOAD_FLUSH_FLAG)
    // 标记只认 10s 内的（flush 后立即重放）：崩溃/中断残留的陈标记不作数，下次刷新照常兜底
    return Date.now() - Number(v) < 10_000
  }
  function hasUnsavedWork(): boolean {
    // R44-2（四十四轮）：口径只看 dirty——conflict && !dirty 是已决断残留态（overwrite/
    // reload/discard 都会清 conflict，残留不可丢失），拦刷新只会无谓卡死；losable 面
    // 与 flushDirty 的扫描面（dirty && !saving && !conflict）∪（dirty && conflict 守卫面）一致
    // RC 源码重审 B-2（Opus-5.5 轮）：并入编辑器正文回写的防抖尾——窗口内刚键入的正文
    // 尚未落回 store（entry.dirty 仍 false），只看 dirty 会放行刷新、把这段键入静默丢掉。
    // 判 pending 即拦下：随后的 flushDirty 会先落尾再保存（B-2 的 flush 点之一）。
    if (hasPendingBodyWriteback()) return true
    for (const e of doc.docs.values()) if (e.dirty) return true
    return false
  }
  function flushOnUnload(e: BeforeUnloadEvent): void {
    if (consumeFreshReloadFlag()) return // flush 落定后的重放刷新：放行
    if (!hasUnsavedWork()) return
    e.preventDefault()
    e.returnValue = '' // 旧 Chrome/Safari 惯例位（preventDefault 之外的兼容）
    void doc.flushDirty().then(() => {
      if (!hasUnsavedWork()) {
        sessionStorage.setItem(RELOAD_FLUSH_FLAG, String(Date.now()))
        location.reload()
        return
      }
      ui.toast('有修改尚未安全落盘（保存失败或冲突未决），已阻止刷新——请在编辑器内处理后重试', 'warning')
    })
  }
  type CloseFlushWindow = Window & {
    __clwFlushBeforeClose?: () => Promise<{ failed: string[]; conflict: string[] }>
  }
  onMounted(() => {
    window.addEventListener('beforeunload', flushOnUnload)
    // 主进程 close/before-quit 拦截的调用面（钩子与页面同生命周期注册/注销；不在编辑页
    // 时无 dirty 状态，主进程拿不到钩子即直接关，无兜底需求）
    // R0911-C1-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：钩子首位并入书级 prefs 冲刷
    // ——workspace store 的 500ms 防抖窗内末次布局态此前随关窗静默丢失（R48-82 备案的
    // 取舍，本批收口）；对齐 App.vue __clwFlushPrefs 为全局偏好做的事（同一
    // executeJavaScript 表达式内先行冲刷的先例）。书级 prefs 只在进书（Book 挂载）后有
    // 待写项，挂本页钩子即覆盖全部有丢失窗的时机；冲刷链内部消化失败（不 reject），
    // 吞错兜底不阻断后续文档保存与关窗。
    ;(window as CloseFlushWindow).__clwFlushBeforeClose = async () => {
      await ws.flushPendingBookPrefs().catch(() => {})
      return doc.flushBeforeClose()
    }
  })
  onUnmounted(() => {
    window.removeEventListener('beforeunload', flushOnUnload)
    delete (window as CloseFlushWindow).__clwFlushBeforeClose
  })

  // RB-FE-P1-2：路由离开 /book（组件卸载，watch(bookName) 不再触发）也 flush 脏文档——
  // 选 onUnmounted 而非 onBeforeRouteLeave：覆盖一切卸载路径（路由跳转/程序化导航）。
  // flushDirty 内部逐文档 try/catch（save 永不 reject），fire-and-forget 安全，不阻塞卸载
  // F1（五十九轮）：flush 失败（仍 dirty 未落盘）时 console.warn 留痕——组件即将销毁，
  // 无处再提示作者，至少留下可回溯的失败证据（.版本 快照是恢复底线）
  onUnmounted(() =>
    void doc.flushDirty().then((failed) => {
      // R37-1（三十七轮批E）：卸载路径无界面可弹——flush 等待窗口内落成的 conflict（不在
      // failed 口径）一并留痕，与卸载时的 failed 同口径（组件已销毁，快照是恢复底线）
      const conflict = doc.conflictedDirtyDocs()
      if (failed.length > 0 || conflict.length > 0) {
        console.warn(`[Book] 卸载时 ${failed.length} 个文档保存失败（编辑未落盘）: ${failed.join(', ')}；${conflict.length} 个文档冲突未决: ${conflict.join(', ')}`)
      }
    }),
  )
}

