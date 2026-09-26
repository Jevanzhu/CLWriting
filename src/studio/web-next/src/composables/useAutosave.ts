/**
 * 自动保存节拍独立成 composable。
 *
 * 为什么独立：节拍（interval）的起、重起、停三处必须成对——此前它散在 Book.vue setup
 * 顶层（onMounted(startAutosave) / watch(effectiveAutosaveInterval, startAutosave) /
 * onUnmounted(clearInterval)），三者相隔几十行，间隔配置改动或新增卸载路径时极易漏掉
 * 清停（漏停 = 卸载后定时器继续跑 doc.autosaveTick 对已切书的 store 空转）。收进一个
 * 文件后启停同处一屏，且可就节奏本身直测（见 test/studio/webnext/book-autosave-timer.
 * test.ts）。
 *
 * 语义零变化：逐行搬迁 Book.vue 原自动保存块（的「节拍上移 Book 层」沿革随迁），
 * 仅 store 在本函数内取实例。
 */
import { onMounted, onUnmounted, watch } from 'vue'
import { useDocStore } from '../stores/doc'
import { usePrefsStore } from '../stores/prefs'

/** 注册自动保存节拍（随组件实例挂载起拍、间隔变更重起、卸载停表）。 */
export function useAutosave(): void {
  const doc = useDocStore()
  const prefs = usePrefsStore()
  // 自动保存节拍上移 Book 层——此前绑 EditorView 挂载，切到工作台/
  // 总览等视图后编辑器卸载、interval 被清，store 里的 dirty 文档停止自动保存（丢失窗口
  // 超过 autosave 间隔）。扫描逻辑在 doc.autosaveTick（覆盖全部打开文档，非仅当前编辑器）。
  let autosaveTimer: ReturnType<typeof setInterval> | null = null
  function startAutosave(): void {
    if (autosaveTimer) clearInterval(autosaveTimer)
    autosaveTimer = setInterval(() => doc.autosaveTick(), Math.max(5, prefs.effectiveAutosaveInterval) * 1000)
  }
  onMounted(startAutosave)
  watch(() => prefs.effectiveAutosaveInterval, startAutosave)
  onUnmounted(() => {
    if (autosaveTimer) clearInterval(autosaveTimer)
    autosaveTimer = null
  })
}
