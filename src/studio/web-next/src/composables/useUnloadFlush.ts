/**
 * 关窗/刷新/卸载冲刷链路（独立 composable）。
 *
 * 三条兜底路径：①关窗（主进程 close 拦截经 executeJavaScript 调
 * window.__clwFlushBeforeClose，含书级 prefs 先冲刷）；②刷新/导航（beforeunload preventDefault →
 * 异步 flushDirty → 落净后带一次性标记重放，含冲突守卫）；③卸载（onUnmounted fire-and-forget
 * flush + 失败/冲突留痕）。三者共享「什么算未保存工作」（hasUnsavedWork）与同一批 doc/workspace
 * store 出口——写成页面 setup 顶层时清理链（监听/全局钩子注销）与业务分支混在一处，是最容易漏项的
 * 一类改动面。
 *
 * 生命周期（成对清理）：onMounted 挂 beforeunload 监听 + 注册全局钩子；onUnmounted 摘监听 + 删全局
 * 钩子 + fire-and-forget flushDirty 留痕——注册与注销同文件相邻，漏项不可能只改一边。
 * 各 store 在本函数内取实例。
 */
import { onMounted, onUnmounted } from 'vue'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { hasPendingBodyWriteback } from '../shared/body-writeback'
import { runCloseTasks } from '../shared/close-flush'

/** 关窗钩子的返回面（与主进程 flushRendererBeforeClose 的契约）。 */
type CloseFlushResult = { failed: string[]; conflict: string[] }
type CloseFlushWindow = Window & { __clwFlushBeforeClose?: () => Promise<CloseFlushResult> }

/** 卸载期在途冲刷句柄——组件已销毁后主进程关窗仍须等它落定，否则 destroy 会掐断在途保存。 */
let pendingUnmountFlush: Promise<void> | null = null
/** 关窗钩子在册者计数（App 常驻 1 份 + Book 在册 1 份）。离书态 App 仍在册 → 钩子留着。 */
let closeHookHolders = 0

/** 关窗兜底体（单源）：关窗待办（心跳释放等）→ 书级 prefs → 卸载期在途冲刷 → 文档冲刷。 */
async function runCloseFlush(): Promise<CloseFlushResult> {
  await runCloseTasks()
  await useWorkspaceStore()
    .flushPendingBookPrefs()
    .catch(() => {})
  if (pendingUnmountFlush) await pendingUnmountFlush.catch(() => {})
  return useDocStore().flushBeforeClose()
}

/** 在册一份关窗钩子（同一钩子体；在册者互不覆盖）。 */
function installCloseHook(): void {
  closeHookHolders++
  ;(window as CloseFlushWindow).__clwFlushBeforeClose = runCloseFlush
}

/** 注销一份在册（最后一位离册才摘钩子，且只摘自己装的那一枚）。 */
function releaseCloseHook(): void {
  closeHookHolders = Math.max(0, closeHookHolders - 1)
  if (closeHookHolders === 0 && (window as CloseFlushWindow).__clwFlushBeforeClose === runCloseFlush) {
    delete (window as CloseFlushWindow).__clwFlushBeforeClose
  }
}

/** 应用级注册关窗兜底（App.vue 调）——钩子必须覆盖「已离书」态：Book 卸载即摘钩子会让
 *  主进程拿不到可等待的钩子直接 destroy，掐断卸载期在途保存（叠加镜像清扫即丢编辑）。 */
export function useAppCloseFlush(): void {
  onMounted(installCloseHook)
  onUnmounted(releaseCloseHook)
}

/** 注册关窗/刷新/卸载三条冲刷链（随组件实例挂载注册、卸载注销）。 */
export function useUnloadFlush(): void {
  const doc = useDocStore()
  const ui = useUiStore()

  // 关窗/刷新兜底改双路。①关窗：主进程在 close 拦截后经
  // executeJavaScript 调 window.__clwFlushBeforeClose（页面未死，异步保存链全通），
  // 落定/短超时后 destroy——Chromium ≥M80 在页面卸载路径整体禁同步 XHR，原渲染层
  // 同步 XHR 兜底经双 Electron 实验实证零字节到达，已删。
  // ②刷新/导航：beforeunload preventDefault 挡下（页面未死）→ 异步 flushDirty →
  // 全部落净后带一次性标记重放刷新；未落净（保存失败/冲突未决）不自动重放，toast
  // 告知后由作者处理（冲突守卫并入本监听；Electron 不渲染浏览器
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
    // 口径只看 dirty——conflict && !dirty 是已决断残留态（overwrite/
    // reload/discard 都会清 conflict，残留不可丢失），拦刷新只会无谓卡死；losable 面
    // 与 flushDirty 的扫描面（dirty && !saving && !conflict）∪（dirty && conflict 守卫面）一致
    // 并入编辑器正文回写的防抖尾——窗口内刚键入的正文
    // 尚未落回 store（entry.dirty 仍 false），只看 dirty 会放行刷新、把这段键入静默丢掉。
    // 判 pending 即拦下：随后的 flushDirty 会先落尾再保存（的 flush 点之一）。
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
  onMounted(() => {
    window.addEventListener('beforeunload', flushOnUnload)
    // 主进程 close/before-quit 拦截的调用面：本页在册一份，App 级再在册一份（见
    // useAppCloseFlush）——离书后 App 那份仍在，钩子不会随本页卸载消失；钩子体先冲刷
    // 书级 prefs（500ms 防抖窗内的末次布局态），再等卸载期在途冲刷与文档保存链落定，
    // 各段内部消化失败（不 reject），一段失败不阻断其余兜底。
    installCloseHook()
  })
  onUnmounted(() => {
    window.removeEventListener('beforeunload', flushOnUnload)
    releaseCloseHook()
  })

  // 路由离开 /book（组件卸载，watch(bookName) 不再触发）也 flush 脏文档——
  // 选 onUnmounted 而非 onBeforeRouteLeave：覆盖一切卸载路径（路由跳转/程序化导航）。
  // flushDirty 内部逐文档 try/catch（save 永不 reject），fire-and-forget 安全，不阻塞卸载
  // flush 失败（仍 dirty 未落盘）时 console.warn 留痕——组件即将销毁，
  // 无处再提示作者，至少留下可回溯的失败证据（.版本 快照是恢复底线）
  onUnmounted(
    () =>
      void (pendingUnmountFlush = doc.flushDirty().then((failed) => {
        // 卸载路径无界面可弹——flush 等待窗口内落成的 conflict（不在
        // failed 口径）一并留痕，与卸载时的 failed 同口径（组件已销毁，快照是恢复底线）
        const conflict = doc.conflictedDirtyDocs()
        if (failed.length > 0 || conflict.length > 0) {
          console.warn(
            `[Book] 卸载时 ${failed.length} 个文档保存失败（编辑未落盘）: ${failed.join(', ')}；${conflict.length} 个文档冲突未决: ${conflict.join(', ')}`,
          )
        }
      })),
  )
}
