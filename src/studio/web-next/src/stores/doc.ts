import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContent, saveContent, finalizeDoc } from '../api/documents'
import { ApiError } from '../api/client'
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

/** F7（五十九轮）：clean 文档 LRU 上限——长会话翻几十章全部常驻内存；超出后从最旧
 *  开始驱逐非 active、非 dirty 的 entry（dirty/conflict/saving 永不驱逐——未落盘
 *  编辑/未决冲突不可丢，被驱逐的 clean 文档切回时重读即可）。 */
const MAX_CACHED_DOCS = 20

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
    // R33D-26（三十三轮 dev 线）：inflightOpens 同口径清——legacy docId 按路径派生跨书可同 id，
    // A 书在途 open 的 promise 被 B 书同名 open 复用后其结果被 bookGen 守卫整体丢弃
    //（promise resolve 但缓存无 entry，调用方空手而归）。清台账让 B 书 open 真发新请求。
    inflightOpens.clear()
    // R33-12（三十三轮 win 线）：inflightSaves 一并清——旧书在途保存的 finally 无条件按
    // docId 删键，若新书（legacy docId 按路径派生跨书同键）已在途同 docId 保存，
    // 旧 settle 会误删新登记 → ⌘S 走进 e.saving 分支且 inflight 取不到 → 无闸
    // 同步尾递归（RangeError，保存静默失败）。
    inflightSaves.clear()
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

  /** 打开文档：读内容 + 算基线 revision + 入 Map。已打开或加载中则不重读。
   *  R31-31（三十一轮）：并发去重改「返回在途 promise」——原裸 return 让
   *  `await doc.open()` 即刻 resolve 而 entry 未落位，调用方（EditorView 的
   *  pendingInsert 补消费只等一拍 nextTick）在慢网下消费不到挂起信号。 */
  const inflightOpens = new Map<string, Promise<void>>()
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
    const running = inflightOpens.get(node.docId)
    if (running) return running
    const docId = node.docId
    const p = doOpen(docId, node)
    inflightOpens.set(docId, p)
    try {
      await p
    } finally {
      // R40-38（四十轮）：identity 删键——setBook 清台账（R33D-26）后新书同 docId 的
      // 二次 open 已登记新 promise，旧 open 的 finally 无条件按 docId 删会把新条目
      // 误删（去重失效微窗）；仅当 Map 内暂存仍是自身 promise 才删（对齐 inflightSaves
      // 下方「get === p 才删」的 R33-12 口径）
      if (inflightOpens.get(docId) === p) inflightOpens.delete(docId)
    }
  }

  /** R31-31：open 的实际执行体（读 + 基线 + 入缓存）。docId 已由 open 收窄校验。 */
  async function doOpen(docId: string, node: TreeNode): Promise<void> {
    loading.add(docId)
    // RB-FE-P2-1：进入时代数——await 期间切书（setBook bump bookGen）则丢弃结果，
    // 防旧书 doc 注入新书缓存（后续 save 会用新书名写旧书内容）
    const gen = bookGen
    const book = bookName.value!
    try {
      const content = await getContent(book, node.path)
      const baselineRevision = await sha256Revision(content)
      if (gen !== bookGen) return
      docs.value.set(docId, {
        docId,
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
      // R33-71（三十三轮）：代守卫——切书后旧 open 的 finally 不得释放新书同 docId
      // 的在途加载锁（否则新书可重复 GET；结果注入有 gen 守卫，仅冗余请求面）
      if (gen === bookGen) loading.delete(docId)
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
      // R33-12（三十三轮）：条件删——只撤自己登记（切书 clear 后新书同 docId 的
      // 新登记不得被旧书 settle 的无条件 delete 抹掉）
      if (inflightSaves.get(docId) === p) inflightSaves.delete(docId)
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
        // R43-16（四十三轮）：save 成功对齐 treeRev 至当前树版本——dirty 期间错过的树刷新
        //（syncCleanWithTree 跳过 dirty 项不回填）让 treeRev 停在旧版，下一次树刷新会把
        // 自客户端保存当外部变更整批重拉（每文档 GET + sha256 白耗）；乐观锁已保证落盘
        // 基线为最新，按当前树版本视作新鲜。
        e.treeRev = useTreeStore().revision
        // E4：刷新今日字数增量（fire-and-forget 重 GET delta）
        void useWordsStore().ensureBaseline(book)
        if (origin === 'manual') useUiStore().toast('已保存', 'success')
      }
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        e.conflict = true
        e.error = '此文档已在其他地方修改'
      } else if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        // R33-13（三十三轮）：文档已删除（软删后 404）→ 移除缓存条目——dirty 僵尸
        // entry 此前驻留 Map：autosaveTick 每 30s 对已删 docId 无限重试（404 后 dirty
        // 不清）、LRU 永不驱逐、切书 flushDirty 计入 failed 触发「保存失败将永久丢弃」
        // 假警报。discard 同时清 inflightSaves（本 promise 正在 settle 链上，条件删兜底）。
        docs.value.delete(docId)
        // 本 promise 的在途登记由 save 的 finally 条件删收口（get === p）
        if (origin === 'manual') useUiStore().toast('文档已删除，已清理本地缓存', 'info')
        return false
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
   *  守卫下沉到 store 前 EditorView/MetaFormPanel 各自 patch 回本地正文，现全调用方统一受保护。
   *  R30-7（三十轮）：补返回值 Promise<boolean>（成功 true / 失败 false）——既有吞错
   *  语义不变（catch 不上抛），仅让调用方能感知结果；忽略返回值的既有调用方零影响。 */
  async function refresh(docId: string): Promise<boolean> {
    const e = docs.value.get(docId)
    if (!e) return false
    try {
      const content = await getContent(bookName.value!, e.path)
      if (e.dirty && e.content !== content) {
        // fm 以服务端为准（refresh 的目的），正文以本地为准（未保存编辑）
        e.content = mergeFm(content, stripFrontmatter(e.content))
        e.baselineRevision = await sha256Revision(content)
        return true
      }
      e.content = content
      const rev = await sha256Revision(content)
      // ee-P1-7：await 窗口内作者键入（patch 置 dirty）时不得清 dirty——否则 autosave/
      // beforeunload 双兜底同时被跳过，编辑静默丢失（CC-P2-15 只护住了上面的 dirty 分支）
      e.baselineRevision = rev
      if (e.content === content) e.dirty = false
      return true
    } catch {
      // R30-7（三十轮）：保持既有静默吞错（best-effort 对齐磁盘），仅以 false 上报失败
      return false
    }
  }

  /** E-4（二十九轮）：树刷新后的 clean 缓存新鲜度对账（tree store load 成功处调用）——
   *  打开时记录的树版本（treeRev）与当前树版本不一致、且非 dirty/conflict/saving 的
   *  缓存项静默重拉，内容对齐磁盘（外部改动的冲突不必拖到保存才暴露）。LRU/驱逐语义
   *  不变：命中项就地更新、不重排 Map 迭代序（重排会扰动 F7 的访问序 LRU）。
   *  R35-32：路径对账——他窗 rename/move 后树已刷新而缓存 entry 仍记旧路径，按 docId
   *  命中新节点即回填 path/name/role/mode：否则本次 refresh 按旧路径 404 静默失败、
   *  后续保存的树字数局部更新 updateWordCount(旧path) 永远 no-op。 */
  async function syncCleanWithTree(book: string, curRev: string): Promise<void> {
    if (!curRev || bookName.value !== book) return
    const tree = useTreeStore()
    for (const e of docs.value.values()) {
      const node = tree.byDocId.get(e.docId)
      if (node && node.path !== e.path) {
        e.path = node.path
        e.name = node.name
        e.role = node.role
        e.mode = modeOf(node.path)
      }
    }
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

  /** R37-1（三十七轮批E）：flushDirty 等待在途保存的纯等待轮次上限——防活锁（在途
   *  promise 落定后又立刻出现新在途的极端交叠，如 ⌘S 链式重存反复叠加）。超限后仍
   *  saving 的条目按原口径跳过（不进 failed）——autosaveTick 节拍 30s 级 vs flush
   *  窗口 ms 级，真实撞上的概率极低；取舍：宁可极少见地留给快照兜底，不在切书路径
   *  上引入无限等待。 */
  const FLUSH_WAIT_INFLIGHT_MAX_ROUNDS = 3

  /** 切书前批量保存所有 dirty 文档（await 全部完成，防 setBook 清缓存致 <autosaveInterval 的编辑静默丢失）。
   *  Q-3（第十五轮）：改循环冲排——原一次性快照在 await 窗口内定格，保存期间的新键入
   *  （编辑器仍挂载旧书可继续输入）与「保存中收到的新击键」（快照排除 saving 项）都不在
   *  快照内，setBook 清缓存即静默丢失。每轮重扫直至无待存；保存失败（save 返 false 且
   *  仍 dirty）的文档本轮不再重试防死循环；冲突文档留作者决断。
   *  F1（五十九轮）：返回未落盘（保存失败仍 dirty）的 docId 列表——调用方（Book.vue
   *  切书守卫 / 卸载留痕）据此决断，不再静默丢编辑。
   *  R37-1（三十七轮批E）：先落定在途保存——原过滤条件 !e.saving 把「saving 中的脏
   *  条目」直接排除出扫描（本轮跳过、failed 也不含它），调用方（切书守卫）以为已落盘
   *  即 setBook 清缓存，在途保存与其后链式重存（F8 manual 等待链）覆盖的编辑被静默
   *  丢弃。改为：收集 saving 条目的在途 promise，allSettled 落定后重扫——落定后仍
   *  dirty（快照后新键入/保存失败）自然进入下方扫描闭环。 */
  async function flushDirty(): Promise<string[]> {
    const failed = new Set<string>()
    let waitRounds = 0
    for (;;) {
      const inflight = [...docs.value.values()]
        .filter((e) => e.saving && e.dirty)
        .map((e) => inflightSaves.get(e.docId))
        .filter((p): p is Promise<boolean> => !!p)
      if (inflight.length > 0 && waitRounds < FLUSH_WAIT_INFLIGHT_MAX_ROUNDS) {
        waitRounds++
        // allSettled：单个在途保存 reject（doSave 内已 catch 转 return false，正常不
        // reject；防御链式 save 的 inflight.catch 分支异常）不阻断其余落定
        await Promise.allSettled(inflight)
        continue
      }
      const dirty = [...docs.value.values()].filter(
        (e) => e.dirty && !e.saving && !e.conflict && !failed.has(e.docId),
      )
      if (dirty.length === 0) return [...failed]
      waitRounds = 0 // 本轮发生了实际保存：纯等待计数重新起算（连续纯等待才计上限）
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

  /** R44-2（四十四轮）：关窗/退出兜底——主进程在 close/before-quit 拦截后经
   *  executeJavaScript 调本钩子，此时页面未进卸载、异步保存链全通（Chromium ≥M80
   *  在页面卸载路径整体禁同步 XHR，原 beforeunload 内同步 PUT 兜底经双 Electron
   *  实验实证零字节到达，已随本钩子移除）。conflict 项不代存（autosave/flushDirty
   *  均跳过，需作者在应用内决断重载/覆盖），原样上抛给主进程弹原生确认（R44-19：
   *  渲染层 beforeunload preventDefault 在 Electron 是无反馈死关窗）。token 缺失由
   *  apiJson 的 401→rebootstrap 自动重取（R42-15），无需旧同步 re-boot 通道。 */
  async function flushBeforeClose(): Promise<{ failed: string[]; conflict: string[] }> {
    const failed = await flushDirty()
    return { failed, conflict: conflictedDirtyDocs() }
  }

  /** R33-13（三十三轮）：显式丢弃缓存条目（删除文档后调用）——清 entry + 在途登记，
   *  防脏 dirty 僵尸 entry 无限重试/切书假警报。entry 在途保存时其 finally 条件删兜底。 */
  function discard(docId: string): void {
    docs.value.delete(docId)
    inflightSaves.delete(docId)
  }

  return { docs, bookName, setBook, get, open, patch, save, reloadFromRemote, overwriteRemote, refresh, syncCleanWithTree, finalize, conflictedDirtyDocs, flushDirty, flushBeforeClose, autosaveTick, discard }
})
