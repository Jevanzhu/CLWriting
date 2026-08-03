import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContent, saveContent } from '../api/documents'
import { ApiError } from '../api/client'
import { sha256Revision, newOperationId } from '../shared/revision'
import { useUiStore } from './ui'
import { useTreeStore } from './tree'
import { useWordsStore } from './words'
import { countWords, stripFrontmatter } from '../shared/words'
import type { TreeNode } from '../types/tree'

/**
 * 文档 store（细案 §5）：Map<docId, DocEntry>。
 * 打开即入 Map，切 tab 不丢 dirty（对旧版「切文件丢脏」的修正，决策 R6）。
 * 保存走 documents API 乐观锁（expectedRevision + operationId + origin）。
 * legacy 文档（旧书无清单登记）同样走此路径：首次保存时 service 层自动补登记
 * （adoptLegacyDoc），从而也获得快照/历史/冲突检测——不再降级盲写。
 */

import { isBodyKind } from '../shared/words'
import { friendlyError } from '../shared/error'

/** 编辑模式：正文/草稿 = text（纯文本不高亮），设定/大纲/工作区(非草稿) = md（语法高亮）。 */
function modeOf(path: string): 'text' | 'md' {
  if (isBodyKind(path)) return 'text'
  if (/(?:^|\/)草稿-\d+\.md$/.test(path)) return 'text'
  return 'md'
}

export interface DocEntry {
  docId: string
  path: string
  name: string
  mode: 'text' | 'md'
  content: string
  baselineRevision: `sha256:${string}`
  dirty: boolean
  saving: boolean
  savedAt: number | null
  error: string | null
  /** 乐观锁冲突未决：外部已修改，等用户选「重载/覆盖」；期间 autosave 跳过（必再冲突）。 */
  conflict: boolean
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
    docs.value.set(node.docId, {
      docId: node.docId,
      path: node.path,
      name: node.name,
      mode: modeOf(node.path),
      content,
      baselineRevision: await sha256Revision(content),
      dirty: false,
      saving: false,
      savedAt: null,
      error: null,
      conflict: false,
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

  /** 保存：走乐观锁 PUT。origin 区分手动/自动。 */
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
      const r = await saveContent(bookName.value!, docId, {
        content: snapshot,
        expectedRevision: e.baselineRevision,
        operationId: newOperationId(),
        origin,
      })
      e.baselineRevision = r.revision
      e.conflict = false
      if (e.content === snapshot) e.dirty = false
      e.savedAt = Date.now()
      // 局部更新 tree 字数（避免重拉整树）
      useTreeStore().updateWordCount(e.path, countWords(stripFrontmatter(snapshot)))
      // E4：刷新今日字数增量（fire-and-forget 重 GET delta）
      void useWordsStore().ensureBaseline(bookName.value!)
      if (origin === 'manual') useUiStore().toast('已保存', 'success')
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        e.conflict = true
        e.error = '此文档已在其他地方修改'
      } else {
        e.error = friendlyError(err)
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
      e.baselineRevision = await sha256Revision(content)
      e.dirty = false
      e.conflict = false
      e.error = null
      useUiStore().toast('已加载最新版本', 'success')
    } catch (err) {
      useUiStore().toast(friendlyError(err), 'error')
    }
  }

  /** 冲突出路②覆盖：以远端当前内容算基线 revision，再把本地内容写上去（覆盖外部修改）。 */
  async function overwriteRemote(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e || e.saving) return
    try {
      const remote = await getContent(bookName.value!, e.path)
      e.baselineRevision = await sha256Revision(remote)
      e.conflict = false
      e.error = null
      await save(docId, 'manual')
    } catch (err) {
      useUiStore().toast(friendlyError(err), 'error')
    }
  }

  /** 静默刷新文档内容（外部改了 fm 等，重新拉对齐磁盘；不 toast、不重置 conflict）。 */
  async function refresh(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e) return
    try {
      const content = await getContent(bookName.value!, e.path)
      e.content = content
      e.baselineRevision = await sha256Revision(content)
      e.dirty = false
    } catch {
      /* 静默失败（best-effort 对齐磁盘） */
    }
  }

  return { docs, bookName, setBook, get, open, patch, save, reloadFromRemote, overwriteRemote, refresh }
})
