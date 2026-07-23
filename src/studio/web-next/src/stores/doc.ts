import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContent, saveContent, putFileBlind } from '../api/documents'
import { ApiError } from '../api/client'
import { sha256Revision, newOperationId } from '../shared/revision'
import { useUiStore } from './ui'
import type { TreeNode } from '../types/tree'

/**
 * 文档 store（细案 §5）：Map<docId, DocEntry>。
 * 打开即入 Map，切 tab 不丢 dirty（对旧版「切文件丢脏」的修正，决策 R6）。
 * 保存走 documents API 乐观锁（expectedRevision + operationId + origin）。
 */

/** 编辑模式：正文/草稿 = text（纯文本不高亮），设定/大纲/工作区(非草稿) = md（语法高亮）。 */
function modeOf(path: string): 'text' | 'md' {
  if (path.startsWith('定稿/正文/')) return 'text'
  if (/(?:^|\/)草稿-\d+\.md$/.test(path)) return 'text'
  return 'md'
}

export interface DocEntry {
  docId: string
  path: string
  name: string
  mode: 'text' | 'md'
  content: string
  baselineRevision: `sha256:${string}` | null
  dirty: boolean
  saving: boolean
  savedAt: number | null
  error: string | null
  /** legacy 未登记文档：保存降级 PUT /file 盲写（无乐观锁），细案 §2.1 兜底。 */
  legacy: boolean
}

export const useDocStore = defineStore('doc', () => {
  const docs = ref<Map<string, DocEntry>>(new Map())
  const bookName = ref<string | null>(null)

  /** 切书：清空缓存（不同书的 docId 不通用）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    bookName.value = name
    docs.value = new Map()
  }

  function get(docId: string): DocEntry | undefined {
    return docs.value.get(docId)
  }

  /** 打开文档：读内容 + 算基线 revision + 入 Map。已打开则不重读。 */
  async function open(node: TreeNode): Promise<void> {
    if (!node.docId) throw new Error('节点无 docId')
    if (docs.value.has(node.docId)) return
    const content = await getContent(bookName.value!, node.path)
    const legacy = node.docId.startsWith('legacy:')
    // legacy 文档无服务端登记，baselineRevision 仅作展示基线（保存走盲写不用它）
    const baselineRevision = legacy ? null : await sha256Revision(content)
    docs.value.set(node.docId, {
      docId: node.docId,
      path: node.path,
      name: node.name,
      mode: modeOf(node.path),
      content,
      baselineRevision,
      dirty: false,
      saving: false,
      savedAt: null,
      error: null,
      legacy,
    })
  }

  /** 编辑器内容变更 → 标 dirty。 */
  function patch(docId: string, content: string): void {
    const e = docs.value.get(docId)
    if (!e || e.content === content) return
    e.content = content
    e.dirty = true
    e.error = null
  }

  /** 保存：正式文档走乐观锁 PUT；legacy 降级 PUT /file 盲写。origin 区分手动/自动。 */
  async function save(docId: string, origin: 'manual' | 'autosave' = 'manual'): Promise<boolean> {
    const e = docs.value.get(docId)
    if (!e || e.saving || !e.dirty) return false
    e.saving = true
    e.error = null
    try {
      if (e.legacy) {
        // legacy 未登记：盲写兜底（无锁，细案 §2.1）
        await putFileBlind(bookName.value!, e.path, e.content)
      } else {
        const r = await saveContent(bookName.value!, docId, {
          content: e.content,
          expectedRevision: e.baselineRevision,
          operationId: newOperationId(),
          origin,
        })
        e.baselineRevision = r.revision
      }
      e.dirty = false
      e.savedAt = Date.now()
      if (origin === 'manual') useUiStore().toast('已保存', 'success')
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        e.error = '文件已被外部修改，请重载或覆盖'
      } else {
        e.error = err instanceof Error ? err.message : String(err)
      }
      useUiStore().toast(e.error, 'error')
      return false
    } finally {
      e.saving = false
    }
  }

  return { docs, bookName, setBook, get, open, patch, save }
})
