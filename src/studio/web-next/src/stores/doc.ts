import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContent, saveContent, finalizeDoc } from '../api/documents'
import { ApiError, getToken } from '../api/client'
import { sha256Revision, newOperationId } from '../shared/revision'
import { useUiStore } from './ui'
import { useTreeStore } from './tree'
import { useWorkspaceStore } from './workspace'
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
  /** E-4（二十九轮）：打开时的树版本快照（tree store revision）——树重扫推进版本后，
   *  与当前版本不一致的 clean 缓存项可能已过期（外部改动），由 syncCleanWithTree 静默重拉。 */
  treeRev?: string
}

/** 卸载兜底同步落盘的总预算（ms）：串行同步 XHR 超预算即放弃余下文档（尽力而为）。 */
const FLUSH_SYNC_BUDGET_MS = 2_000

/** F7（五十九轮）：clean 文档 LRU 上限——长会话翻几十章全部常驻内存；超出后从最旧
 *  开始驱逐非 active、非 dirty 的 entry（dirty/conflict/saving 永不驱逐——未落盘
 *  编辑/未决冲突不可丢，被驱逐的 clean 文档切回时重读即可）。 */
const MAX_CACHED_DOCS = 20

/** F3（五十九轮）：卸载窗口内的同步 re-boot——GET /api/boot（免鉴权端点）取新 token。
 *  同步 XHR（对应异步通道 rebootstrap 的卸载版）：失败/无 token 返 null，由调用方留痕放弃。 */
function bootTokenSync(): string | null {
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/api/boot', false)
    xhr.send()
    const data = JSON.parse(xhr.responseText || '{}') as { token?: unknown }
    return typeof data.token === 'string' && data.token ? data.token : null
  } catch {
    return null
  }
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

  /** F7（五十九轮）：LRU 驱逐——Map 迭代序 = 访问序（旧→新，R64-31 起 open 命中会重排），
   *  超上限后从最久未用开始跳过 active/dirty/conflict/saving 项驱逐 clean 文档。
   *  active 判定走 workspace store（延迟取实例，避开与 workspace→doc 的模块环在初始化期互撞）。 */
  function evictLRU(): void {
    const active = useWorkspaceStore().activeDocId
    for (const [id, e] of docs.value) {
      if (docs.value.size <= MAX_CACHED_DOCS) return
      if (id === active || e.dirty || e.conflict || e.saving) continue
      docs.value.delete(id)
    }
  }

  /** 打开文档：读内容 + 算基线 revision + 入 Map。已打开或加载中则不重读。 */
  async function open(node: TreeNode): Promise<void> {
    if (!node.docId) throw new Error('节点无 docId')
    // R64-31（十二轮）：命中重排（Map 迭代序 = LRU 序）——不重排则 evictLRU 实为 FIFO，
    // 交替使用的文档被误驱逐；重插不新建 entry，仅移动迭代位置
    const cached = docs.value.get(node.docId)
    if (cached) {
      docs.value.delete(node.docId)
      docs.value.set(node.docId, cached)
      return
    }
    if (loading.has(node.docId)) return
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
        // E-4（二十九轮）：记录打开时的树版本，供树刷新后对账新鲜度
        treeRev: useTreeStore().revision,
      })
      evictLRU() // F7（五十九轮）：新 entry 落位后裁剪 clean 缓存至 LRU 上限
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

  /** F8（五十九轮）：在途保存的 promise 台账——⌘S 遇在途保存时链式排队用（等在途
   *  settle 后重存一次，期间新输入不在在途快照内）。 */
  const inflightSaves = new Map<string, Promise<boolean>>()

  /** 保存：走乐观锁 PUT。origin 区分手动/自动。
   *  F8（五十九轮）：manual 遇在途保存不再静默 no-op——await 在途 promise 后若仍有
   *  dirty（在途快照之后的新输入）则链式再存一次；autosave 维持原 no-op（节拍自会重扫）。 */
  async function save(docId: string, origin: 'manual' | 'autosave' = 'manual'): Promise<boolean> {
    const e = docs.value.get(docId)
    if (!e) return false
    if (e.saving) {
      if (origin !== 'manual') return false
      const inflight = inflightSaves.get(docId)
      if (inflight) await inflight.catch(() => {})
      const cur = docs.value.get(docId)
      if (!cur || !cur.dirty) return false
      return save(docId, origin)
    }
    if (!e.dirty) return false
    // 冲突未决时 autosave 必再冲突，跳过重试（也避免每 30s 一条错误提示），等用户选重载/覆盖
    if (e.conflict && origin === 'autosave') return false
    const p = doSave(e, origin)
    inflightSaves.set(docId, p)
    try {
      return await p
    } finally {
      inflightSaves.delete(docId)
    }
  }

  /** 单次保存执行体（save 的在途守卫/排队解耦后落在这里）。 */
  async function doSave(e: DocEntry, origin: 'manual' | 'autosave'): Promise<boolean> {
    const docId = e.docId
    e.saving = true
    e.error = null
    // 快照本次落盘内容：await 期间的新输入不属于本次保存，成功后不得误清其 dirty
    const snapshot = e.content
    // P5-前端（第七轮）：书名快照——保存请求在途切书后，成功分支的树字数/今日增量/
    // toast 不再落到新书（B 书同路径节点会被写脏字数、错误提示出现在 B 书界面）
    const book = bookName.value!
    try {
      const r = await saveContent(book, docId, {
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
        void useWordsStore().ensureBaseline(book)
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
    // X-28：书名快照（同 save 的 P5 前置守卫）——重载在途切书（setBook 清缓存）后，
    // 迟到的成功/失败 toast 不落新书界面；结果写进已脱离缓存的旧 entry，无实害
    const book = bookName.value!
    try {
      const content = await getContent(book, e.path)
      e.content = content
      e.baselineRevision = await sha256Revision(content)
      e.dirty = false
      e.conflict = false
      e.error = null
      if (bookName.value !== book) return
      useUiStore().toast('已加载最新版本', 'success')
    } catch (err) {
      if (bookName.value !== book) return
      useUiStore().toast(friendlyError(err), 'error')
    }
  }

  /** 冲突出路②覆盖：以远端当前内容算基线 revision，再把本地内容写上面（覆盖外部修改）。 */
  async function overwriteRemote(docId: string): Promise<void> {
    const e = docs.value.get(docId)
    if (!e || e.saving) return
    // X-28：同 reloadFromRemote 的书名快照——覆盖在途切书后迟到错误 toast 不落新书；
    // 内部 save 已自带书名快照守卫（切书后 docId 不在新缓存，save 直接 no-op）
    const book = bookName.value!
    try {
      const remote = await getContent(book, e.path)
      e.baselineRevision = await sha256Revision(remote)
      e.conflict = false
      e.error = null
      await save(docId, 'manual')
    } catch (err) {
      if (bookName.value !== book) return
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

  /** E-4（二十九轮）：树刷新后的 clean 缓存新鲜度对账（tree store load 成功处调用）——
   *  打开时记录的树版本（treeRev）与当前树版本不一致、且非 dirty/conflict/saving 的
   *  缓存项静默重拉，内容对齐磁盘（外部改动的冲突不必拖到保存才暴露）。LRU/驱逐语义
   *  不变：命中项就地更新、不重排 Map 迭代序（重排会扰动 F7 的访问序 LRU）。 */
  async function syncCleanWithTree(book: string, curRev: string): Promise<void> {
    if (!curRev || bookName.value !== book) return
    const stale = [...docs.value.values()].filter(
      (e) => e.treeRev !== curRev && !e.dirty && !e.conflict && !e.saving,
    )
    await Promise.all(
      stale.map(async (e) => {
        try {
          const content = await getContent(book, e.path)
          const rev = await sha256Revision(content)
          // await 窗口复检：已切书 / 条目被清或已转 dirty/conflict/saving（期间有本地
          // 编辑/在途保存）→ 放弃回写，交由常规保存/打开路径处理
          if (bookName.value !== book) return
          const cur = docs.value.get(e.docId)
          if (cur !== e || e.dirty || e.conflict || e.saving) return
          e.content = content
          e.baselineRevision = rev
          e.treeRev = curRev
        } catch {
          /* 静默失败（best-effort 对齐磁盘）：下次树刷新再对账 */
        }
      }),
    )
  }

  /** 定稿确认（revision → final）：git commit 锁定当前版本。成功后刷新树（状态变 final）。 */
  async function finalize(docId: string): Promise<boolean> {
    if (!bookName.value) return false
    // L-F3（第八轮）：入口快照——定稿在途切书后 load/toast 用重读书名会落 B 书界面
    const book = bookName.value
    try {
      const r = await finalizeDoc(book, docId)
      if (r.ok) {
        // R64-3（十二轮）：定稿在途切书复检——L-F3 快照只防「重读书名落 B 书」，未防
        // 过期书名的 load/toast 本身；迟到的 load(A) 会后发后至覆盖 B 书树
        if (bookName.value !== book) return true // 已切书：定稿已落 A 书盘，树由切书链自刷
        // 定稿后 git 干净 → 树节点 status 变 final；重拉树刷新状态标签
        void useTreeStore().load(book, true)
        const e = docs.value.get(docId)
        if (e) e.savedAt = Date.now()
        useUiStore().toast(r.skipped ? '已是定稿' : '已定稿', 'success')
        return true
      }
      return false
    } catch (err) {
      // R69-28（十七轮）：catch 补切书守卫——成功路径有 R64-3 复检，catch 漏配：定稿
      // 在途（git 提交可达数秒）切到 B 书后，A 书的失败 toast 会弹在 B 书界面
      if (bookName.value !== book) return false
      if (err instanceof ApiError && err.code === 'NOT_DRAFT_REGION') {
        useUiStore().toast('仅正文/设定文档可定稿', 'error')
      } else {
        useUiStore().toast(friendlyError(err), 'error')
      }
      return false
    }
  }

  /** 切书前批量保存所有 dirty 文档（await 全部完成，防 setBook 清缓存致 <autosaveInterval 的编辑静默丢失）。
   *  Q-3（第十五轮）：改循环冲排——原一次性快照在 await 窗口内定格，保存期间的新键入
   *  （编辑器仍挂载旧书可继续输入）与「保存中收到的新击键」（快照排除 saving 项）都不在
   *  快照内，setBook 清缓存即静默丢失。每轮重扫直至无待存；保存失败（save 返 false 且
   *  仍 dirty）的文档本轮不再重试防死循环；冲突文档留作者决断。
   *  F1（五十九轮）：返回未落盘（保存失败仍 dirty）的 docId 列表——调用方（Book.vue
   *  切书守卫 / 卸载留痕）据此决断，不再静默丢编辑。 */
  async function flushDirty(): Promise<string[]> {
    const failed = new Set<string>()
    for (;;) {
      const dirty = [...docs.value.values()].filter(
        (e) => e.dirty && !e.saving && !e.conflict && !failed.has(e.docId),
      )
      if (dirty.length === 0) return [...failed]
      await Promise.all(
        dirty.map(async (e) => {
          const ok = await save(e.docId, 'autosave')
          // 保存未成（仍 dirty 且失败）→ 标记跳过；保存成功后再次置脏（窗口内新键入）
          // 不标记——下轮重扫会再存，正是要救的编辑
          if (!ok) failed.add(e.docId)
        }),
      )
    }
  }

  /** Z-8（第五十八轮）：存在未决冲突的脏文档（切书守卫用）——这些文档的本地修改从未
   *  落盘（autosave 跳过 conflict 项），setBook 清缓存即不可恢复丢失，切书前须作者决断 */
  function conflictedDirtyDocs(): string[] {
    return [...docs.value.values()].filter((e) => e.conflict && e.dirty && !e.saving).map((e) => e.docId)
  }

  /** 自动保存节拍（Q-9 从 EditorView 上移）：扫全部 dirty 且不在保存中、无冲突的文档
   *  批量落盘——此前节拍绑编辑器视图挂载，切到工作台/总览后 EditorView 卸载、dirty
   *  文档停止自动保存（丢失窗口超过 autosave 间隔）。 */
  function autosaveTick(): void {
    for (const e of docs.value.values()) {
      if (e.dirty && !e.saving && !e.conflict) void save(e.docId, 'autosave')
    }
  }

  /** 卸载兜底（V-P1-2）：beforeunload 窗口内异步 fetch 不保证送达，改用同步 XHR 尽力落盘。
   *  只处理 dirty 且无冲突且不在保存中的文档；失败静默——最近 autosave/手动保存 + 服务端
   *  .版本 快照仍是恢复底线。页面即将销毁，不回写 store 状态。
   *  总预算上限（FLUSH_SYNC_BUDGET_MS）：串行同步 XHR 每次都可能阻塞，多文档无限串行
   *  会把页面卸载卡死在浏览器手里——超预算即放弃余下文档（尽力而为语义：同步 XHR 无法
   *  中断在途单次请求，只能在请求之间检查；放弃的文档由 autosave 历史快照兜底）。 */
  function flushSyncOnUnload(): void {
    if (!bookName.value) return
    let token = getToken()
    // F3（五十九轮）：boot 失败后 token 为 null，无 token 的同步 PUT 必 401——关窗兜底
    // 形同虚设。boot 端点免鉴权：先同步 XHR 重新取 token（异步 rebootstrap 的 fetch 在
    // 卸载窗口不保证送达，此处必须同步），失败 console.warn 留痕后放弃——发必 401 的
    // 请求只会白阻塞卸载窗口。
    if (token === null) {
      token = bootTokenSync()
      if (token === null) {
        console.warn('[flushSyncOnUnload] token 缺失且同步 re-boot 失败，卸载兜底落盘未执行（编辑由 .版本 快照兜底）')
        return
      }
    }
    const deadline = Date.now() + FLUSH_SYNC_BUDGET_MS
    for (const e of docs.value.values()) {
      if (!e.dirty || e.saving || e.conflict) continue
      // 预算耗尽：放弃余下文档（卸载路径尽力而为，不阻塞页面销毁）
      if (Date.now() > deadline) break
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

  return { docs, bookName, setBook, get, open, patch, save, reloadFromRemote, overwriteRemote, refresh, syncCleanWithTree, finalize, conflictedDirtyDocs, flushDirty, flushSyncOnUnload, autosaveTick }
})
