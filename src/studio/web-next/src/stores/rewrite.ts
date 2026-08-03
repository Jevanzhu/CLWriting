import { defineStore } from 'pinia'
import { ref } from 'vue'
import { runRewriteDoc, reportAiVersion, type RewriteResult } from '../api/rewrite'
import { useDocStore } from './doc'
import { friendlyError } from '../shared/error'

/**
 * 改写 store（M12 块2 B2.2）：触发改写 + diff 结果；接受 → rewritten 写入 doc content（dirty，作者 ⌘S 保存）。
 * apply 不走后端（最纯提案模型，AI 永不直接落盘正文）。选区改写后置（当前 whole 整章）。
 */
export const useRewriteStore = defineStore('rewrite', () => {
  const result = ref<RewriteResult | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function run(name: string, docId: string, instruction: string, selection: string, append = false): Promise<void> {
    loading.value = true
    error.value = null
    try {
      // append（M2 续写解选区）：无选区纯追加；否则有选区 local / 无选区 whole
      const body = append ? { instruction, append: true } : selection ? { instruction, selection } : { instruction }
      result.value = await runRewriteDoc(name, docId, body)
    } catch (e) {
      error.value = friendlyError(e)
      result.value = null
    } finally {
      loading.value = false
    }
  }

  /** 接受改写 → rewritten 写入 doc content（dirty）；作者 ⌘S 走标准保存。
   *  接受瞬间上报 AI 版进改稿轨迹（文风S2，fire-and-forget，失败静默）。 */
  function accept(name: string, docId: string): void {
    if (!result.value) return
    void reportAiVersion(name, docId, result.value.rewritten).catch(() => {})
    useDocStore().patch(docId, result.value.rewritten)
    result.value = null
  }

  function reject(): void {
    result.value = null
  }

  function clear(): void {
    result.value = null
    error.value = null
  }

  return { result, loading, error, run, accept, reject, clear }
})
