import { defineStore } from 'pinia'
import { ref } from 'vue'
import { runRewriteDoc, reportAiVersion, type RewriteResult } from '../api/rewrite'
import { useDocStore } from './doc'
import { useUiStore } from './ui'
import { friendlyError } from '../shared/error'
import { stripFrontmatter, mergeFm } from '../shared/words'

/**
 * 改写 store（M12 块2 B2.2）：触发改写 + diff 结果；接受 → rewritten 写入 doc content（dirty，作者 ⌘S 保存）。
 * apply 不走后端（最纯提案模型，AI 永不直接落盘正文）。选区改写后置（当前 whole 整章）。
 */
export const useRewriteStore = defineStore('rewrite', () => {
  const result = ref<RewriteResult | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** M-11：代守卫——切书 clear() 后在途改写结果不再落地（accept 虽有 docId 兜底防跨书
   *  patch，但 B 书改写面板不该显示 A 书的 diff 结果；error/loading 回填同样查代） */
  let reqGen = 0

  async function run(name: string, docId: string, instruction: string, selection: string, append = false): Promise<void> {
    const gen = ++reqGen
    loading.value = true
    error.value = null
    try {
      // W-P1-4：改写基线在服务端读磁盘（readDraft），dirty 内容必须先落盘——否则「接受」
      // 会用磁盘旧版拼出的 rewritten 覆盖本地未保存的编辑（从未落盘，.版本 也救不回）。
      const doc = useDocStore()
      const entry = doc.get(docId)
      if (entry?.dirty) {
        if (entry.conflict) {
          error.value = '文档有未解决的保存冲突，请先重载或覆盖后再改写'
          result.value = null
          return
        }
        const saved = await doc.save(docId, 'manual')
        if (gen !== reqGen) return
        // R34D-22（三十四轮）：save 返 false ≠ 保存失败——manual 排队复查在「在途
        // 保存已把全部内容落盘（dirty 已清）」时按「无需重存」返 false（F8 契约，
        // f8-manual-save-queue 钉死），内容实已在磁盘、改写基线（服务端读盘）安全；
        // 仅 dirty 仍在（真保存失败/冲突未决）才取消改写。此前无差别按失败取消，
        // 排队窗口内的改写被误杀（内容明明已落盘）。
        if (!saved && doc.get(docId)?.dirty) {
          error.value = entry.error ?? '改写前保存失败，已取消改写'
          result.value = null
          return
        }
      }
      // append（M2 续写解选区）：无选区纯追加；否则有选区 local / 无选区 whole
      const body = append ? { instruction, append: true } : selection ? { instruction, selection } : { instruction }
      const r = await runRewriteDoc(name, docId, body)
      if (gen !== reqGen) return
      result.value = r
    } catch (e) {
      if (gen !== reqGen) return
      error.value = friendlyError(e)
      result.value = null
    } finally {
      if (gen === reqGen) loading.value = false
    }
  }

  /** 接受改写 → rewritten 写入 doc content（dirty）；作者 ⌘S 走标准保存。
   *  接受瞬间上报 AI 版进改稿轨迹（文风S2，fire-and-forget，失败静默）。
   *  W-P1-4：生成期间正文又被编辑 → 基线过期，fail-closed 拒绝接受（防静默覆盖新编辑）；
   *  rewritten 是服务端剥 fm 的正文级产出，patch 前用 mergeFm 把章节 fm 拼回（此前直接
   *  patch 会把 front matter 整个丢掉，保存后 readDraft 即失败）。 */
  function accept(name: string, docId: string): boolean {
    const r = result.value
    if (!r) return false
    const doc = useDocStore()
    const e = doc.get(docId)
    if (!e) return false
    const localBody = stripFrontmatter(e.content).replace(/^\n+/, '').trim()
    if (localBody !== r.original.replace(/^\n+/, '').trim()) {
      useUiStore().toast('生成后正文有新的编辑，为防覆盖已取消接受；请撤销新编辑后再试，或重新生成', 'error')
      return false
    }
    void reportAiVersion(name, docId, r.rewritten).catch(() => {})
    doc.patch(docId, mergeFm(e.content, r.rewritten))
    result.value = null
    return true
  }

  function reject(): void {
    result.value = null
  }

  function clear(): void {
    reqGen++ // M-11：在途 run 的结果/错误回填全部作废
    result.value = null
    error.value = null
    // R-1 第十六轮修复族（learn/check/review 均有，rewrite 漏网，X-2 补齐）：
    // 切书在途改写被作废后 loading 不复位 → 改写面板按钮永久禁用
    loading.value = false
  }

  return { result, loading, error, run, accept, reject, clear }
})
