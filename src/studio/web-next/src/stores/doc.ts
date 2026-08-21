import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContent, saveContent, finalizeDoc } from '../api/documents'
import { ApiError, getToken } from '../api/client'
import { sha256Revision, newOperationId } from '../shared/revision'
import { useUiStore } from './ui'
import { useTreeStore } from './tree'
import { useWordsStore } from './words'
import { countWords, stripFrontmatter, mergeFm } from '../shared/words'
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

/** 编辑模式：正文 = text（纯文本不高亮），设定/大纲/其他 = md（语法高亮）。 */
function modeOf(path: string): 'text' | 'md' {
  if (isBodyKind(path)) return 'text'
  return 'md'
}

export interface DocEntry {
  docId: string
  path: string
  name: string
  /** 文档角色（后端 buildTree 标注；短篇判定读 book.yaml kind——role 恒 'chapter'，
   *  'piece-body' 是历史 wire 兼容位，后端从不产出（P5-数据层·第七轮注释校准））。 */
  role: string
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
  /** 加载中文档的防并发锁（同一 docId 不重复发起请求） */
  const loading = new Set<string>()
  const bookName = ref<string | null>(null)
  /** 切书代数：作废在途 open 的结果（参考 workspace.ts 的 bookGen 守卫） */
  let bookGen = 0

  /** 切书：清空缓存（不同书的 docId 不通用）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    bookName.value = name
    docs.value = new Map()
    // RB-FE-P2-1：清 loading 锁 + bump 代数——在途 open 的旧书响应不得注入新书缓存
    loading.clear()
    bookGen++
  }

  function get(docId: string): DocEntry | undefined {
    return docs.value.get(docId)
  }

  /** 打开文档：读内容 + 算基线 revision + 入 Map。已打开或加载中则不重读。 */
  async function open(node: TreeNode): Promise<void> {
    if (!node.docId) throw new Error('节点无 docId')
    if (docs.value.has(node.docId) || loading.has(node.docId)) return
    loading.add(node.docId)
    // RB-FE-P2-1：进入时代数——await 期间切书（setBook bump bookGen）则丢弃结果，
    // 防旧书 doc 注入新书缓存（后续 save 会用新书名写旧书内容）
    const gen = bookGen
    const book = bookName.value!
    try {
      const content = await getContent(book, node.path)
      const baselineRevision = await sha256Revision(content)
      if (gen !== bookGen) return
      docs.value.set(node.docId, {
        docId: node.docId,
        path: node.path,
        name: node.name,
        role: node.role,
        mode: modeOf(node.path),
        content,
        baselineRevision,
        dirty: false,
        saving: false,
        savedAt: null,
        error: null,
        conflict: false,
      })
    } finally {
      loading.delete(node.docId)
    }
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
    // P5-前端（第七轮）：书名快照——保存请求在途切书后，成功分支的树字数/今日增量/
    // toast 不再落到新书（B 书同路径节点会被写脏字数、错误提示出现在 B 书界面）
    const book = bookName.value!
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
      if (bookName.value === book) {
        // 局部更新 tree 字数（避免重拉整树）
        useTreeStore().updateWordCount(e.path, countWords(stripFrontmatter(snapshot)))
        // E4：刷新今日字数增量（fire-and-forget 重 GET delta）
        void useWordsStore().ensureBaseline(bookName.value!)
        if (origin === 'manual') useUiStore().toast('已保存', 'success')
      }
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

  /** 静默刷新文档内容（外部改了 fm 等，重新拉对齐磁盘；不 toast、不重置 conflict）。
   *  CC-P2-15：本地有未保存编辑（含 await 窗口内的键盘输入）时不整体覆盖——
   *  只取服务端 fm、正文保留本地、dirty 不清，否则编辑被静默丢弃。
   *  守卫下沉到 store 前 EditorView/MetaFormPanel 各自 patch 回本地正文，现全调用方统一受保护。 */
  async function refresh(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e) return
    try {
      const content = await getContent(bookName.value!, e.path)
      if (e.dirty && e.content !== content) {
        // fm 以服务端为准（refresh 的目的），正文以本地为准（未保存编辑）
        e.content = mergeFm(content, stripFrontmatter(e.content))
        e.baselineRevision = await sha256Revision(content)
        return
      }
      e.content = content
      const rev = await sha256Revision(content)
      // ee-P1-7：await 窗口内作者键入（patch 置 dirty）时不得清 dirty——否则 autosave/
      // beforeunload 双兜底同时被跳过，编辑静默丢失（CC-P2-15 只护住了上面的 dirty 分支）
      e.baselineRevision = rev
      if (e.content === content) e.dirty = false
    } catch {
      /* 静默失败（best-effort 对齐磁盘） */
    }
  }

  /** 定稿确认（revision → final）：git commit 锁定当前版本。成功后刷新树（状态变 final）。 */
  async function finalize(docId: string): Promise<boolean> {
    if (!bookName.value) return false
    try {
      const r = await finalizeDoc(bookName.value, docId)
      if (r.ok) {
        // 定稿后 git 干净 → 树节点 status 变 final；重拉树刷新状态标签
        void useTreeStore().load(bookName.value, true)
        const e = docs.value.get(docId)
        if (e) e.savedAt = Date.now()
        useUiStore().toast(r.skipped ? '已是定稿' : '已定稿', 'success')
        return true
      }
      return false
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_DRAFT_REGION') {
        useUiStore().toast('仅正文/设定文档可定稿', 'error')
      } else {
        useUiStore().toast(friendlyError(err), 'error')
      }
      return false
    }
  }

  /** 切书前批量保存所有 dirty 文档（await 全部完成，防 setBook 清缓存致 <autosaveInterval 的编辑静默丢失）。 */
  async function flushDirty(): Promise<void> {
    const dirty = [...docs.value.values()].filter((e) => e.dirty && !e.saving && !e.conflict)
    await Promise.all(dirty.map((e) => save(e.docId, 'autosave')))
  }

  /** 卸载兜底（V-P1-2）：beforeunload 窗口内异步 fetch 不保证送达，改用同步 XHR 尽力落盘。
   *  只处理 dirty 且无冲突且不在保存中的文档；失败静默——最近 autosave/手动保存 + 服务端
   *  .版本 快照仍是恢复底线。页面即将销毁，不回写 store 状态。 */
  function flushSyncOnUnload(): void {
    if (!bookName.value) return
    const token = getToken()
    for (const e of docs.value.values()) {
      if (!e.dirty || e.saving || e.conflict) continue
      try {
        const xhr = new XMLHttpRequest()
        xhr.open(
          'PUT',
          `/api/books/${encodeURIComponent(bookName.value)}/documents/${encodeURIComponent(e.docId)}/content`,
          false,
        )
        xhr.setRequestHeader('Content-Type', 'application/json')
        if (token) xhr.setRequestHeader('x-studio-token', token)
        xhr.send(
          JSON.stringify({
            content: e.content,
            expectedRevision: e.baselineRevision,
            operationId: newOperationId(),
            origin: 'autosave',
          }),
        )
      } catch {
        /* 卸载路径尽力而为 */
      }
    }
  }

  return { docs, bookName, setBook, get, open, patch, save, reloadFromRemote, overwriteRemote, refresh, finalize, flushDirty, flushSyncOnUnload }
})
