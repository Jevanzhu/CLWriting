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
  /** 乐观锁冲突未决：外部已修改，等用户选「重载/覆盖」；期间 autosave 跳过（必再冲突）。 */
  conflict: boolean
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
      conflict: false,
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
    // 冲突未决时 autosave 必再冲突，跳过重试（也避免每 30s 一条错误提示），等用户选重载/覆盖
    if (e.conflict && origin === 'autosave') return false
    e.saving = true
    e.error = null
    // 快照本次落盘内容：await 期间的新输入不属于本次保存，成功后不得误清其 dirty
    const snapshot = e.content
    try {
      if (e.legacy) {
        // legacy 未登记：盲写兜底（无锁，细案 §2.1）
        await putFileBlind(bookName.value!, e.path, snapshot)
      } else {
        const r = await saveContent(bookName.value!, docId, {
          content: snapshot,
          expectedRevision: e.baselineRevision,
          operationId: newOperationId(),
          origin,
        })
        e.baselineRevision = r.revision
      }
      e.conflict = false
      if (e.content === snapshot) e.dirty = false
      e.savedAt = Date.now()
      if (origin === 'manual') useUiStore().toast('已保存', 'success')
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        e.conflict = true
        e.error = '文件已被外部修改'
      } else {
        e.error = err instanceof Error ? err.message : String(err)
      }
      // autosave 失败不弹 toast（编辑器状态条已展示 error，避免周期性刷屏）
      if (origin === 'manual') useUiStore().toast(e.error, 'error')
      return false
    } finally {
      e.saving = false
    }
  }

  /** 冲突出路①重载：丢弃本地修改，取远端最新内容为准。 */
  async function reloadFromRemote(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e || e.saving) return
    try {
      const content = await getContent(bookName.value!, e.path)
      e.content = content
      e.baselineRevision = e.legacy ? null : await sha256Revision(content)
      e.dirty = false
      e.conflict = false
      e.error = null
      useUiStore().toast('已重载远端内容', 'success')
    } catch (err) {
      useUiStore().toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 冲突出路②覆盖：以远端当前内容算基线 revision，再把本地内容写上去（覆盖外部修改）。 */
  async function overwriteRemote(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e || e.saving || e.legacy) return
    try {
      const remote = await getContent(bookName.value!, e.path)
      e.baselineRevision = await sha256Revision(remote)
      e.conflict = false
      e.error = null
      await save(docId, 'manual')
    } catch (err) {
      useUiStore().toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return { docs, bookName, setBook, get, open, patch, save, reloadFromRemote, overwriteRemote }
})
