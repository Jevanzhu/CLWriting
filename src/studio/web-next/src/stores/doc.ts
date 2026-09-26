import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getContentPayload, saveContent, finalizeDoc } from '../api/documents'
import { ApiError } from '../api/client'
import { sha256Revision, newOperationId } from '../shared/revision'
import { exceedsSaveBodyLimit, SAVE_TOO_LARGE_MESSAGE } from '../shared/save-limits'
import { createDirtyMirror } from '../shared/dirty-mirror'
import { flushBodyWriteback, registerBodyWritebackDirty } from '../shared/body-writeback'
import { useStaleGuard } from '../composables/useStaleGuard'
import { useUiStore } from './ui'
import { useTreeStore } from './tree'
import { useWorkspaceStore } from './workspace'
import { useWordsStore } from './words'
import { countWords, stripFrontmatter, mergeFm } from '../shared/words'
import type { TreeNode } from '../types/tree'

/**
 * 文档 store（细案 §5）：Map<docId, DocEntry>。
 * 打开即入 Map，切 tab 不丢 dirty。
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
   *  'piece-body' 是历史 wire 兼容位，后端从不产出）。 */
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
  /** RC：正文超单次保存上限（保存前字节预检拦下，未发起请求）——期间
   *  autosave 跳过重试（每拍重传整文必再超限）；内容再变（patch）即复位复检。 */
  tooLarge?: boolean
  /** RC：已就「版本留底降级」（服务端 .版本 不可写，正文保存成功但没留底）
   *  提示过一次——每文档只提示一次，避免 autosave 每拍刷屏；旗随条目生命周期（切书清
   *  缓存/重开自然复位）。 */
  snapshotDegradedNotified?: boolean
  /** 打开时的树版本快照（tree store revision）——树重扫推进版本后，与当前版本不一致的
   *  clean 缓存项可能已过期（外部改动），由 syncCleanWithTree 静默重拉。 */
  treeRev?: string
}

/** clean 文档 LRU 上限——长会话翻几十章全部常驻内存；超出后从最旧开始驱逐非 active、
 *  非 dirty 的 entry（dirty/conflict/saving 永不驱逐——未落盘编辑/未决冲突不可丢，
 *  被驱逐的 clean 文档切回时重读即可）。 */
const MAX_CACHED_DOCS = 20

export const useDocStore = defineStore('doc', () => {
  const docs = ref<Map<string, DocEntry>>(new Map())
  const bookName = ref<string | null>(null)
  /** 切书代数：作废在途 open 的结果（参考 workspace.ts 的 bookGen 守卫）。
   * 裸计数器换装 useStaleGuard（begin/current 语义映射见工具注；
   *  判定时机不变——doOpen 进入时快照、await 落定后 stale 复检）。 */
  const bookGen = useStaleGuard()

  // ── dirty 正文节流镜像（渲染进程硬崩溃兜底）──
  // 镜像子系统（键格式/节流分档/指纹台账/书级清扫/复活判读）整体在 shared/dirty-mirror.ts
  // 单源（-优化批抽出）——纯 localStorage 逻辑，文档缓存态经 deps 注入（下方
  // docs/bookName 取值器）；本 store 只留五个调用点的薄委托（patch/save/discard/setBook/
  // doOpen）+ 清理单源再导出（改名/删书各链经此调用，键拼法不外泄）。
  const mirror = createDirtyMirror({
    getEntry: (docId) => docs.value.get(docId),
    getBook: () => bookName.value,
  })

  /** 切书：清空缓存（不同书的 docId 不通用）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    // 切书即清前书全部镜像 + pending 节流——能走到 setBook 的 dirty 都已经过
    // flushDirty/守卫决断（保存成功或作者确认丢弃），镜像留存只会造成陈旧复活与跨书累积
    const prevBook = bookName.value
    bookName.value = name
    docs.value = new Map()
    // inflightOpens 同口径清——legacy docId 按路径派生跨书可同 id，A 书在途 open 的
    // promise 被 B 书同名 open 复用后其结果被 bookGen 守卫整体丢弃（promise resolve 但
    // 缓存无 entry，调用方空手而归）。清台账让 B 书 open 真发新请求。
    inflightOpens.clear()
    // inflightSaves 一并清——旧书在途保存的 finally 无条件按 docId 删键，若新书
    //（legacy docId 按路径派生跨书同键）已在途同 docId 保存，旧 settle 会误删新登记 →
    // ⌘S 走进 e.saving 分支且 inflight 取不到 → 无闸同步尾递归（RangeError，保存静默失败）。
    inflightSaves.clear()
    if (prevBook) mirror.clearBookMirrors(prevBook)
    bookGen.invalidate()
  }

  function get(docId: string): DocEntry | undefined {
    return docs.value.get(docId)
  }

  /** LRU 驱逐——Map 迭代序 = 访问序（旧→新，open 命中会重排），超上限后从最久未用开始
   *  跳过 active/dirty/conflict/saving 项驱逐 clean 文档。
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
   *  并发去重返回在途 promise——裸 return 会让 `await doc.open` 即刻 resolve 而 entry
   *  未落位，调用方（EditorView 的 pendingInsert 补消费只等一拍 nextTick）在慢网下消费
   *  不到挂起信号。 */
  const inflightOpens = new Map<string, Promise<void>>()
  async function open(node: TreeNode): Promise<void> {
    if (!node.docId) throw new Error('节点无 docId')
    // 命中重排（Map 迭代序 = LRU 序）——不重排则 evictLRU 实为 FIFO，交替使用的文档被
    // 误驱逐；重插不新建 entry，仅移动迭代位置
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
      // identity 删键——setBook 清台账后新书同 docId 的二次 open 已登记新 promise，旧
      // open 的 finally 无条件按 docId 删会把新条目误删（去重失效微窗）；仅当 Map 内
      // 暂存仍是自身 promise 才删（与 inflightSaves 的「get === p 才删」同款口径）
      if (inflightOpens.get(docId) === p) inflightOpens.delete(docId)
    }
  }

  /** open 的实际执行体（读 + 基线 + 入缓存）。docId 已由 open 收窄校验。 */
  async function doOpen(docId: string, node: TreeNode): Promise<void> {
    // 进入时代数——await 期间切书（setBook bump bookGen）则丢弃结果，防旧书 doc 注入
    // 新书缓存（后续 save 会用新书名写旧书内容）
    // `const gen = bookGen` 只快照不推进 → guard.current（切书作废走 setBook 的 invalidate）
    const gen = bookGen.current()
    // 书名 fail-closed：非空断言 `bookName.value!` 不挡运行时 null（setBook(null)/切书
    // 窗口）——null 会被拼进请求路径（/api/books/null/...）且成功后注入共享 docs。
    // 无书即无「打开」语义，早退（open 的 inflight 台账 finally 照常清理）。
    const book = bookName.value
    if (!book) return
    let content: string
    try {
      // 改取完整载荷——非 UTF-8 存量（GBK/Big5 导入旧稿）经 utf-8 解码即 U+FFFD 乱码且
      // 此前零披露，作者在乱码上编辑保存会被防线 400 拒绝（NOT_UTF8_TARGET）。
      // 打开时 toast 告警指引先转码再编辑（重复打开重复提示，属预期告警语义）。
      const payload = await getContentPayload(book, node.path)
      content = payload.content
      if (payload.encodingSuspect) {
        useUiStore().toast(payload.encodingHint ?? '该文件不是 UTF-8 编码，内容可能显示为乱码', 'error')
      }
    } catch (err) {
      // 打开即 404（文档已被外部删除/残留入口指向已删路径）→ 顺手清该文档的脏镜像——
      // 崩溃残留镜像只认 book+docId，文档已不存在则镜像成无主孤儿，同路径重建新文档
      //（legacy docId 按路径派生，同 id 复用）时 open 会误复活旧镜像污染新文档。其余
      // 错误（网络/5xx）不清——文档还在，镜像仍是有效兜底。
      // 404 原样上抛，调用方既有错误面不变；清理走单源 clearDirtyMirror（内部
      // try/catch 降级，存储不可用时静默）。
      if (err instanceof ApiError && err.code === 'NOT_FOUND') mirror.clearDirtyMirror(book, docId)
      throw err
    }
    const baselineRevision = await sha256Revision(content)
    if (bookGen.stale(gen)) return
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
      // 记录打开时的树版本，供树刷新后对账新鲜度
      treeRev: useTreeStore().revision,
    })
    evictLRU() // 新 entry 落位后裁剪 clean 缓存至 LRU 上限
    // 镜像复活——上次会话崩溃残留的未保存编辑：镜像内容 ≠ 服务端内容时恢复为当前脏内容
    //（baselineRevision 仍为服务端内容之哈希，乐观锁语义不变，autosave/⌘S 照常接管）并
    // 一次性 toast 告知；镜像与服务端一致（内容未丢）则仅清陈旧镜像，不置脏不提示。
    // 复活须过时效门——镜像记录镜像时的服务端基线（baseRev），自崩溃点服务端未变过
    //（baseRev === 当前基线）才许复活。崩溃后同文档被另一存活标签页/外部编辑器更新过
    //（基线已推进）时，陈旧镜像只清不复活——否则旧内容会以匹配的新基线静默覆盖外部
    // 已保存内容（保存零冲突、toast 反报「已恢复」）。旧格式镜像（无 baseRev，升级残留）
    // 同按陈旧处理。
    const saved = mirror.readDirtyMirror(book, docId)
    if (saved) {
      const entry = docs.value.get(docId)
      if (entry && saved.content !== content && saved.baseRev !== null && saved.baseRev === baselineRevision) {
        entry.content = saved.content
        entry.dirty = true
        useUiStore().toast('检测到上次未保存的编辑，已恢复', 'info')
      } else {
        mirror.clearDirtyMirror(book, docId)
      }
    }
  }
  /** 编辑器内容变更 → 标 dirty。 */
  function patch(docId: string, content: string): void {
    const e = docs.value.get(docId)
    if (!e || e.content === content) return
    e.content = content
    e.dirty = true
    e.error = null
    // RC：内容已变 → 超限旗复位（拆分/删减后下一拍 autosave 复检；
    // 未复位则作者拆完文档也仍被跳过，必须重启才恢复自动保存）
    e.tooLarge = false
    // dirty entry 节流镜像（trailing，间隔按内容规模分档）——crash/OOM/kill -9 时
    // <autosave 间隔键入的本地兜底（实现与判读见 shared/dirty-mirror）
    mirror.scheduleDirtyMirror(docId, content.length)
  }

  /** 条目元数据回填（标题提交/树对账后）：只改路径与名称，不动内容与脏位。
   *  组件不得直改缓存条目——条目状态的写口收在 store。 */
  function adoptRenamed(docId: string, path: string, name: string): void {
    const e = docs.value.get(docId)
    if (!e) return
    e.path = path
    e.name = name
  }

  /** 清冲突标记（标题提交成功且正文干净时：autosave 竞态残留的 conflict 不再需要
   *  作者决断）。dirty 时不清——本地正文还没落盘，清了会被 autosave 静默覆盖外部修改。 */
  function clearConflict(docId: string): void {
    const e = docs.value.get(docId)
    if (!e || e.dirty) return
    e.conflict = false
  }

  /** 正文回写窗的首笔标脏（质量评审）：内容仍按 200ms 节流落回，dirty 位在第一笔
   *  键入时同步置位——「先读 dirty 再决定」的判定（历史恢复等）不再依赖每个调用点都
   *  记得先冲刷。只置位不动内容：同内容的重复标脏不产生镜像节流（内容变化由 patch
   *  到点接管）。条目不存在时静默（与 patch 的早退同口径）。 */
  function markEntryDirty(docId: string): void {
    const e = docs.value.get(docId)
    if (!e || e.dirty) return
    e.dirty = true
  }
  registerBodyWritebackDirty(markEntryDirty)

  /** 在途保存的 promise 台账——⌘S 遇在途保存时链式排队用（等在途 settle 后重存一次，
   *  期间新输入不在在途快照内）。 */
  const inflightSaves = new Map<string, Promise<boolean>>()

  /** 保存：走乐观锁 PUT。origin 区分手动/自动。
   *  manual 遇在途保存不静默 no-op——await 在途 promise 后若仍有 dirty（在途快照之后
   *  的新输入）则链式再存一次；autosave 维持 no-op（节拍自会重扫）。
   *  排队链等待轮次有上限（_waitRounds，同 flushDirty 的 FLUSH_WAIT_INFLIGHT_MAX_ROUNDS
   *  防活锁口径）——在途落定后又立刻出现新在途且条目持续置脏的极端交叠下尾递归无界；
   *  超限仍 saving → return false 交 autosaveTick 兜底（dirty 保持，下一节拍重扫）。 */
  async function save(docId: string, origin: 'manual' | 'autosave' = 'manual', _waitRounds = 0): Promise<boolean> {
    // RC：快照前先落编辑器防抖尾（shared/body-writeback）——编辑器正文回写
    // 有 ≤200ms 合并窗，不落尾则本笔快照缺窗内最后一段键入（⌘S 存下的内容比屏幕少），
    // 且该条目此刻可能尚未置脏而整笔被跳过。flush 幂等（无编辑器在场/无待落输入即
    // no-op），autosave 路径同样受益（节拍取到的是屏幕内容）。
    flushBodyWriteback()
    const e = docs.value.get(docId)
    if (!e) return false
    if (e.saving) {
      if (origin !== 'manual') return false
      // 轮次上限（防活锁，口径见函数头注）——超限不等待直接 false，编辑不丢（dirty
      // 保持，autosaveTick 兜底重扫）
      if (_waitRounds >= FLUSH_WAIT_INFLIGHT_MAX_ROUNDS) return false
      const inflight = inflightSaves.get(docId)
      if (inflight) await inflight.catch(() => {})
      const cur = docs.value.get(docId)
      if (!cur || !cur.dirty) return false
      return save(docId, origin, _waitRounds + 1)
    }
    if (!e.dirty) return false
    // 冲突未决时 autosave 必再冲突，跳过重试（也避免每 30s 一条错误提示），等用户选重载/覆盖
    if (e.conflict && origin === 'autosave') return false
    // RC：超限未决时 autosave 必再超限，跳过重试（同 conflict 口径：不刷屏、
    // 不重传整文）；手动保存仍走 doSave —— 由 preflight 给出提示与出路（拆分文档）
    if (e.tooLarge && origin === 'autosave') return false
    const p = doSave(e, origin)
    inflightSaves.set(docId, p)
    try {
      return await p
    } finally {
      // 条件删——只撤自己登记（切书 clear 后新书同 docId 的新登记不得被旧书 settle 的
      // 无条件 delete 抹掉）
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
    // 书名快照——保存请求在途切书后，成功分支的树字数/今日增量/toast 不再落到新书
    //（B 书同路径节点会被写脏字数、错误提示出现在 B 书界面）
    // 书名 fail-closed 守卫（同 doOpen）——无书即无「保存」语义：复位在途旗标后早退
    // false，dirty 保持待有书时 autosave/关窗冲刷再落。
    const book = bookName.value
    if (!book) {
      e.saving = false
      return false
    }
    try {
      // RC：保存前字节预检——超单次上限即不发请求（否则只剩 413 通用
      // 「请求体过大」、autosave 每拍重传整文再失败、切书只剩「丢弃并切换」）。错误
      // 文案给拆分出路上屏（状态条/toast），置 tooLarge 旗停掉 autosave 重试；内容再变
      // 由 patch 复位复检。
      if (exceedsSaveBodyLimit(snapshot)) {
        e.tooLarge = true
        e.error = SAVE_TOO_LARGE_MESSAGE
        if (origin === 'manual') useUiStore().toast(e.error, 'error')
        return false
      }
      const r = await saveContent(book, docId, {
        content: snapshot,
        expectedRevision: e.baselineRevision,
        operationId: newOperationId(),
        origin,
      })
      e.baselineRevision = r.revision
      e.conflict = false
      if (e.content === snapshot) {
        if (e.dirty) mirror.clearDirtyMirror(book, docId) // 已落盘即清镜像（含 pending 节流）
        e.dirty = false
      }
      e.savedAt = Date.now()
      if (bookName.value === book) {
        // 局部更新 tree 字数（避免重拉整树）
        useTreeStore().updateWordCount(e.path, countWords(stripFrontmatter(snapshot)))
        // save 成功对齐 treeRev 至当前树版本——dirty 期间错过的树刷新（syncCleanWithTree
        // 跳过 dirty 项不回填）让 treeRev 停在旧版，下一次树刷新会把自客户端保存当外部
        // 变更整批重拉（每文档 GET + sha256 白耗）；乐观锁已保证落盘基线为最新，按当前树
        // 版本视作新鲜。
        e.treeRev = useTreeStore().revision
        // 刷新今日字数增量（fire-and-forget 重 GET delta）
        void useWordsStore().ensureBaseline(book)
        if (origin === 'manual') useUiStore().toast('已保存', 'success')
        // RC：留底降级可见化——服务端 .版本 不可写时正文照常保存（fail-open），
        // 但「本笔没有留底、版本历史有缺口」必须让作者看见（否则作者面对的是永久写不
        // 进去的死锁，只有状态条一行小字）。每文档只提示一次（snapshotDegradedNotified
        // 随条目生命周期，切书/重开复位）——autosave 每 30s 一拍，不设闸会刷屏。
        if (r.snapshotDegraded && !e.snapshotDegradedNotified) {
          e.snapshotDegradedNotified = true
          useUiStore().toast('本次未生成版本留底（工作区/.版本 不可写？），版本历史可能有缺口——正文已保存', 'info')
        }
      }
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        e.conflict = true
        e.error = '此文档已在其他地方修改'
      } else if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        // 文档已删除（软删后 404）→ 移除缓存条目——dirty 僵尸 entry 若驻留 Map：
        // autosaveTick 每 30s 对已删 docId 无限重试（404 后 dirty 不清）、LRU 永不驱逐、
        // 切书 flushDirty 计入 failed 触发「保存失败将永久丢弃」假警报。
        // discard 同时清 inflightSaves（本 promise 正在 settle 链上，条件删兜底）。
        docs.value.delete(docId)
        // 本 promise 的在途登记由 save 的 finally 条件删收口（get === p）
        mirror.clearDirtyMirror(book, docId) // 文档已删，镜像一并清（复活无主）
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
    // RC：决断前先落编辑器防抖尾（同 refresh 口径）——冲突决断的对象是
    // 「本地正文」，窗口内未落回的键入同属本地正文，须先入 store 再判，「本地修改已按
    // 作者决断丢弃」的语义面才完整（落尾是决断前的最后一次本地快照）。
    flushBodyWriteback()
    const e = docs.value.get(docId)
    if (!e || e.saving) return
    // 书名快照（同 save 的书名守卫）——重载在途切书（setBook 清缓存）后，迟到的成功/
    // 失败 toast 不落新书界面（迟到结果整体放弃写回，见下）
    // 书名 fail-closed 守卫——无书即无「重载」语义，早退。
    const book = bookName.value
    if (!book) return
    // 决断时刻内容快照——await 窗口内的新键入是「重载」决断之后的新编辑，作者从未同意
    // 丢弃。此处若直接覆盖 content 并误清 dirty，窗口内键入会静默丢失且 autosave/关窗
    // 冲刷双兜底同时失明；故须与同文件 refresh / syncCleanWithTree 同款 await 窗口复检。
    const contentAtEntry = e.content
    try {
      // getContent 收敛为 getContentPayload 解构（同端点同 URL 同超时档）
      const content = (await getContentPayload(book, e.path)).content
      const rev = await sha256Revision(content)
      // 双窗口（fetch + sha256）后统一复检，命中任一即放弃覆盖：①已切书（e 已脱离
      // 缓存，对齐 syncCleanWithTree 守卫）；②条目已被替换/弃用（discard、LRU 驱逐后
      // 重开）；③在途保存（快照语义已被保存链接管）；④窗口内新键入（content 偏离决断
      // 时刻快照）。放弃时 conflict 不清，冲突横幅仍在，由作者对「新键入 + 远端已变」
      // 重新决断。
      if (bookName.value !== book || docs.value.get(docId) !== e || e.saving || e.content !== contentAtEntry) {
        return
      }
      e.content = content
      e.baselineRevision = rev
      e.dirty = false
      e.conflict = false
      e.error = null
      // 本地修改已按作者决断丢弃，镜像一并清除（防下次 open 误复活）
      mirror.clearDirtyMirror(book, docId)
      if (bookName.value !== book) return
      useUiStore().toast('已加载最新版本', 'success')
    } catch (err) {
      if (bookName.value !== book) return
      useUiStore().toast(friendlyError(err), 'error')
    }
  }

  /** 冲突出路②覆盖：以远端当前内容算基线 revision，再把本地内容写上面（覆盖外部修改）。 */
  async function overwriteRemote(docId: string): Promise<void> {
    // RC：决断/重写前先落编辑器防抖尾（同 refresh 口径）。
    flushBodyWriteback()
    const e = docs.value.get(docId)
    if (!e || e.saving) return
    // 同 reloadFromRemote 的书名快照——覆盖在途切书后迟到错误 toast 不落新书；内部 save
    // 已自带书名快照守卫（切书后 docId 不在新缓存，save 直接 no-op）
    // 书名 fail-closed 守卫——无书即无「覆盖」语义，早退。
    const book = bookName.value
    if (!book) return
    try {
      // getContent 收敛为 getContentPayload 解构（同端点同 URL 同超时档）
      const remote = (await getContentPayload(book, e.path)).content
      // getContent await 窗口后的条目身份复检（对齐同文件 reloadFromRemote 守卫）——
      // 窗口内条目被 discard（文档删除）/LRU 驱逐重建时，docs 里已不是同一对象，直接写
      // e.baselineRevision 会把新基线落在游离对象上（真条目基线未推进，下次保存吃假
      // REVISION_CONFLICT），clean 分支更会把 e.content 整体回退到保存前的服务端内容。窗口后
      if (bookName.value !== book || docs.value.get(docId) !== e) return
      e.baselineRevision = await sha256Revision(remote)
      // sha256 双 await 窗口同款复检（两段 await 各守一次）
      if (docs.value.get(docId) !== e) return
      e.conflict = false
      e.error = null
      await save(docId, 'manual')
    } catch (err) {
      if (bookName.value !== book) return
      useUiStore().toast(friendlyError(err), 'error')
    }
  }

  /** 静默刷新文档内容（外部改了 fm 等，重新拉对齐磁盘；不 toast、不重置 conflict）。
   *  本地有未保存编辑（含 await 窗口内的键盘输入）时不整体覆盖——只取服务端 fm、正文
   *  保留本地、dirty 不清，否则编辑被静默丢弃。守卫下沉到 store 前 EditorView/
   *  MetaFormPanel 各自 patch 回本地正文，现全调用方统一受保护。
   *  返回值 Promise<boolean>（成功 true / 失败 false）——吞错语义不变（catch 不上抛），
   *  仅让调用方能感知结果；忽略返回值的调用方零影响。 */
  async function refresh(docId: string): Promise<boolean> {
    // RC：外部内容写回前先落编辑器防抖尾（shared/body-writeback）——否则
    // 窗口内刚键入、条目仍 clean（dirty=false）的正文会走下方 clean 分支被服务端内容
    // 整体覆盖，且编辑区随之被 applyExternalReplace 拽回旧文本（store 与屏幕分叉）。
    // 落尾后该条目转 dirty，判据与改前逐位相同。
    flushBodyWriteback()
    const e = docs.value.get(docId)
    // 入口对齐同文件守卫族（reloadFromRemote / overwriteRemote 同款）——在途保存期间不
    // 并发刷新，交保存链接管状态。
    if (!e || e.saving) return false
    // 书名 fail-closed 守卫——无书即无「刷新」语义，早退 false（调用方按刷新失败处理，
    // 既有吞错口径不变）。
    const book = bookName.value
    if (!book) return false
    // 保存完成快照——GET/sha256 双 await 窗口内若有一次保存落定（savedAt 推进），此处抓到
    // 的 content 已陈旧：dirty 分支会把刚写入的新 revision 用旧哈希覆盖（下次保存必吃假
    // REVISION_CONFLICT），clean 分支更会把 e.content 整体回退到保存前的服务端内容。窗口后
    // 复查 saving / savedAt 任一命中即整体放弃写回（对齐「迟到结果整体放弃」口径）。
    const savedAtEntry = e.savedAt
    try {
      // getContent 收敛为 getContentPayload 解构（同端点同 URL 同超时档）
      const content = (await getContentPayload(book, e.path)).content
      if (bookName.value !== book) return false
      if (e.dirty && e.content !== content) {
        // fm 以服务端为准（refresh 的目的），正文以本地为准（未保存编辑）
        // 本地正文本就完整保留——mergeFm 缺省 stripLeading 会剥掉本地正文全部前导空行
        //（编辑路径 EditorView 已显式 stripLeading:false，同型问题换了触发源），此处同样
        // 显式关闭
        // 合并结果先落局部量，守卫通过后才写回——守卫不过时连 content 也不动
        const merged = mergeFm(content, stripFrontmatter(e.content), { stripLeading: false })
        const rev = await sha256Revision(content)
        if (bookName.value !== book || docs.value.get(docId) !== e || e.saving || e.savedAt !== savedAtEntry) {
          return false
        }
        e.content = merged
        e.baselineRevision = rev
        // refresh 成功同样推进 treeRev（对齐 doSave 成功分支口径）——不推进则
        // syncCleanWithTree 的 stale 过滤（treeRev !== curRev）恒命中，refreshed 文档此后
        // 每次树刷新都被冗余重拉（每文档 GET + sha256 白耗）
        e.treeRev = useTreeStore().revision
        return true
      }
      // content 早写 + 失败回滚。早写是复检的窗口锚——sha256 在途期 e.content 可观察为
      // 服务端内容，窗口内键入经「e.content === content」比对胜出（键入优先）。「迟到
      // 结果整体放弃」由下方迟到守卫 + 回滚实现：守卫命中且期间无键入（e.content 仍
      // === content）时回滚到窗口前内容——净分支窗口内保存落定（savedAt 推进）不再把
      // 刚保存的本地内容回退成保存前的服务端快照。
      const prevContent = e.content
      e.content = content
      const rev = await sha256Revision(content)
      if (bookName.value !== book || docs.value.get(docId) !== e || e.saving || e.savedAt !== savedAtEntry) {
        if (e.content === content) e.content = prevContent // 无键入 → 回滚早写
        return false
      }
      e.baselineRevision = rev
      // await 窗口内作者键入（patch 置 dirty）时不得清 dirty——否则 autosave/beforeunload
      // 双兜底同时被跳过，编辑静默丢失（上方 dirty 分支只护住了另一形态）
      if (e.content === content) {
        if (e.dirty) mirror.clearDirtyMirror(book, docId) // 转 clean 即清镜像
        e.dirty = false
      }
      // 同上——clean 分支（refresh 的主路径）也推进，冗余重拉才真正收口
      e.treeRev = useTreeStore().revision
      return true
    } catch {
      // 保持静默吞错语义的「不上抛」半边（best-effort 对齐磁盘），仅以 false 上报失败。
      // UI 面不能为零：「fm 以服务端为准」的关键对齐路径失败若完全静默，作者对着过期
      // 内容继续操作毫无感知；toast warning（同文案 + 同 kind 经 ui.toast 的合并去重天然
      // 防刷屏）。
      if (bookName.value !== book) return false
      useUiStore().toast('文档信息刷新失败，显示内容可能已过期', 'warning')
      return false
    }
  }

  /** 树刷新后的 clean 缓存新鲜度对账（tree store load 成功处调用）——打开时记录的树版本
   *  （treeRev）与当前树版本不一致、且非 dirty/conflict/saving 的缓存项静默重拉，内容
   *  对齐磁盘（外部改动的冲突不必拖到保存才暴露）。LRU/驱逐语义不变：命中项就地更新、
   *  不重排 Map 迭代序（重排会扰动 LRU 的访问序）。
   *  路径对账——他窗 rename/move 后树已刷新而缓存 entry 仍记旧路径，按 docId 命中新节点
   *  即回填 path/name/role/mode：否则本次 refresh 按旧路径 404 静默失败、后续保存的树字数
   *  局部更新 updateWordCount(旧path) 永远 no-op。 */
  async function syncCleanWithTree(book: string, curRev: string): Promise<void> {
    if (!curRev || bookName.value !== book) return
    // RC：对账前先落编辑器防抖尾（同 refresh 口径）——否则窗口内的活动
    // 文档条目仍 clean（dirty=false），会被下方 stale 面重拉整体覆盖（编辑区随之被全量
    // 替换拽回）；落尾后该条目转 dirty，被 stale 过滤自然排除。
    flushBodyWriteback()
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
    const stale = [...docs.value.values()].filter((e) => e.treeRev !== curRev && !e.dirty && !e.conflict && !e.saving)
    await Promise.all(
      stale.map(async (e) => {
        try {
          // getContent 收敛为 getContentPayload 解构（同端点同 URL 同超时档）
          const content = (await getContentPayload(book, e.path)).content
          const rev = await sha256Revision(content)
          // await 窗口复检：已切书 / 条目被清或已转 dirty/conflict/saving（期间有本地
          // 编辑/在途保存）→ 放弃回写，交由常规保存/打开路径处理
          if (bookName.value !== book) return
          const cur = docs.value.get(e.docId)
          if (cur !== e || e.dirty || e.conflict || e.saving) return
          // 树版本复检——本批在途期间树又刷新（重扫/结构性 mutation 推进 revision）时
          // curRev 已过期：迟到回写会把 e.treeRev 盖回旧版（下一轮 sync 整批重复重拉）
          // 并可能写入过期内容。放弃回写，交下一轮 syncCleanWithTree 按新 revision 对账。
          if (tree.revision !== curRev) return
          e.content = content
          e.baselineRevision = rev
          e.treeRev = curRev
        } catch {
          /* best-effort 对齐磁盘的吞错语义保留（不上抛、不中断其余条目），但 UI 面不为零
             ——失败 toast warning 提示「显示内容可能已过期」（同文案经 ui.toast 合并去重，
             多文档批量失败不刷屏）；书名守卫防切书后旧书失败提示落新书界面（对齐上方
             await 窗口复检）。 */
          if (bookName.value === book) {
            useUiStore().toast('文档信息刷新失败，显示内容可能已过期', 'warning')
          }
        }
      }),
    )
  }

  /** 定稿确认（revision → final）：git commit 锁定当前版本。成功后刷新树（状态变 final）。 */
  async function finalize(docId: string): Promise<boolean> {
    if (!bookName.value) return false
    // 入口快照——定稿在途切书后 load/toast 用重读书名会落 B 书界面
    const book = bookName.value
    try {
      const r = await finalizeDoc(book, docId)
      if (r.ok) {
        // 定稿在途切书复检——快照只防「重读书名落 B 书」，未防过期书名的 load/toast
        // 本身；迟到的 load(A) 会后发后至覆盖 B 书树
        if (bookName.value !== book) return true // 已切书：定稿已落 A 书盘，树由切书链自刷
        // 定稿后 git 干净 → 树节点 status 变 final；重拉树刷新状态标签
        void useTreeStore().load(book, true)
        const e = docs.value.get(docId)
        if (e) e.savedAt = Date.now()
        useUiStore().toast(r.skipped ? '已是定稿' : '已定稿', 'success')
        // 防吃书闸降级透出——服务端 fail-open 放行的事实（兑现侧清单不可读/闸门自身
        // 异常）弹 warning toast（对齐机检侧 pushDegradedYellow 黄项口径，作者只看面板
        // 即知该次闭合比对被跳过）。
        if (r.gateDegraded && r.gateDegraded.length > 0) {
          useUiStore().toast(`防吃书检查降级：${r.gateDegraded.join('；')}（已放行定稿）`, 'warning')
        }
        return true
      }
      return false
    } catch (err) {
      // catch 同样要切书守卫——成功路径有复检，这里若无：定稿在途（git 提交可达数秒）
      // 切到 B 书后，A 书的失败 toast 会弹在 B 书界面
      if (bookName.value !== book) return false
      if (err instanceof ApiError && err.code === 'NOT_DRAFT_REGION') {
        useUiStore().toast('仅正文/设定文档可定稿', 'error')
      } else {
        useUiStore().toast(friendlyError(err), 'error')
      }
      return false
    }
  }

  /** flushDirty 等待在途保存的纯等待轮次上限——防活锁（在途 promise 落定后又立刻出现
   *  新在途的极端交叠，如 ⌘S 链式重存反复叠加）。超限后仍 saving 的条目按原口径跳过
   *  （不进 failed）——autosaveTick 节拍 30s 级 vs flush 窗口 ms 级，真实撞上的概率极低；
   *  取舍：宁可极少见地留给快照兜底，不在切书路径上引入无限等待。 */
  const FLUSH_WAIT_INFLIGHT_MAX_ROUNDS = 3

  /** 等待指定文档的在途保存落定（无在途立即返回）。删除确认预判用——save 契约下
   *  doc.save(docId,'autosave') 在 entry.saving 时直接返 false 不等待（节拍自会重扫），
   *  且 dirty 要到保存落定才清：调用方若不先落定在途就判 dirty，在途保存窗口内必误报
   *  「未保存的修改将一并丢失」。等待形态对齐 flushDirty 的台账轮询（同款有界轮次防活锁）。 */
  async function waitInflightSave(docId: string): Promise<void> {
    for (let i = 0; i < FLUSH_WAIT_INFLIGHT_MAX_ROUNDS; i++) {
      const p = inflightSaves.get(docId)
      if (!p) return
      await p.catch(() => {})
    }
  }

  /** 切书前批量保存所有 dirty 文档（await 全部完成，防 setBook 清缓存致 <autosaveInterval 的编辑静默丢失）。
   *  循环冲排而非一次性快照——快照会在 await 窗口内定格，保存期间的新键入（编辑器仍
   *  挂载旧书可继续输入）与「保存中收到的新击键」（快照排除 saving 项）都会漏掉，setBook
   *  清缓存即静默丢失。每轮重扫直至无待存；保存失败（save 返 false 且仍 dirty）的文档
   *  不再重试（防死循环）；冲突文档留作者决断。
   *  返回未落盘（保存失败仍 dirty）的 docId 列表——调用方（Book.vue 切书守卫 / 卸载留痕）
   *  据此决断，不再静默丢编辑。「仍 dirty」按条目身份判定：NOT_FOUND 等已把条目移出缓存
   *  的失败形态不算（文档已不存在，无「未落盘编辑」可丢），不计入返回列表，切书守卫不对
   *  其弹保存失败假警报。
   *  先落定在途保存——过滤条件若把「saving 中的脏条目」直接排除出扫描（跳过、failed 也
   *  不含它），调用方（切书守卫）会以为已落盘即 setBook 清缓存，在途保存与其后链式重存
   *  （manual 等待链）覆盖的编辑被静默丢弃。故收集 saving 条目的在途 promise，allSettled
   *  落定后重扫——落定后仍 dirty（快照后新键入/保存失败）自然进入下方扫描闭环。 */
  async function flushDirty(): Promise<string[]> {
    // RC：扫描前先落编辑器防抖尾——否则「窗口内刚键入、
    // 回写尚未到点（故 dirty 仍为 false）」的条目不在下方 dirty 扫描面内，切书
    // setBook 清缓存/关窗即把这段键入静默丢弃（红线）。flush 幂等、无待落即 no-op；
    // 落回可能新增/推进 dirty 项，故必须在扫描之前（save 路径会再 flush 一次，幂等）。
    flushBodyWriteback()
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
      const dirty = [...docs.value.values()].filter((e) => e.dirty && !e.saving && !e.conflict && !failed.has(e.docId))
      if (dirty.length === 0) return [...failed]
      waitRounds = 0 // 发生了实际保存：纯等待计数重新起算（连续纯等待才计上限）
      await Promise.all(
        dirty.map(async (e) => {
          const ok = await save(e.docId, 'autosave')
          // 保存未成（仍 dirty 且失败）→ 标记跳过；保存成功后再次置脏（窗口内新键入）
          // 不标记——下轮重扫会再存，正是要救的编辑
          // 条目身份复检——NOT_FOUND 分支已把条目移出 Map（不再 dirty，无编辑可丢），
          // 这类幽灵条目不得计入 failed（切书守卫假警报）；条目仍在且仍是同一实例
          //（未被 discard / LRU 驱逐重建）才是「保存失败仍 dirty」
          if (!ok && docs.value.get(e.docId) === e) failed.add(e.docId)
        }),
      )
    }
  }

  /** 存在未决冲突的脏文档（切书守卫用）——这些文档的本地修改从未落盘（autosave 跳过
   *  conflict 项），setBook 清缓存即不可恢复丢失，切书前须作者决断 */
  function conflictedDirtyDocs(): string[] {
    return [...docs.value.values()].filter((e) => e.conflict && e.dirty && !e.saving).map((e) => e.docId)
  }

  /** 自动保存节拍（从 EditorView 上移）：扫全部 dirty 且不在保存中、无冲突的文档批量
   *  落盘——节拍若绑编辑器视图挂载，切到工作台/总览后 EditorView 卸载、dirty 文档停止
   *  自动保存（丢失窗口超过 autosave 间隔）。 */
  function autosaveTick(): void {
    for (const e of docs.value.values()) {
      if (e.dirty && !e.saving && !e.conflict) void save(e.docId, 'autosave')
    }
  }

  /** 关窗/退出兜底——主进程在 close/before-quit 拦截后经 executeJavaScript 调本钩子，
   *  此时页面未进卸载、异步保存链全通（Chromium ≥M80 在页面卸载路径整体禁同步 XHR，
   *  故不能靠 beforeunload 内同步 PUT 兜底）。conflict 项不代存（autosave/flushDirty 均
   *  跳过，需作者在应用内决断重载/覆盖），原样上抛给主进程弹原生确认（渲染层
   *  beforeunload preventDefault 在 Electron 是无反馈死关窗）。token 缺失由 apiJson 的
   *  401→rebootstrap 自动重取，无需同步 re-boot 通道。 */
  async function flushBeforeClose(): Promise<{ failed: string[]; conflict: string[] }> {
    const failed = await flushDirty()
    return { failed, conflict: conflictedDirtyDocs() }
  }

  /** 显式丢弃缓存条目（删除文档后调用）——清 entry + 在途登记，防脏 dirty 僵尸 entry
   *  无限重试/切书假警报。entry 在途保存时其 finally 条件删兜底。 */
  function discard(docId: string): void {
    docs.value.delete(docId)
    inflightSaves.delete(docId)
    // inflightOpens 同口径清（setBook 先例）——删除后同 docId 重开（同名重建/回收站
    // 还原）窗口内 open 会命中在途旧 promise（旧 doOpen 的 getContent 已 404 或内容
    // 已旧），复用旧 promise 要么直接 reject 要么落过期内容。同步删键让重开必发新请求；
    // 旧 open 的 finally 为 identity 条件删，不会误删新登记。
    inflightOpens.delete(docId)
    mirror.clearDirtyMirror(bookName.value, docId) // 条目已弃，镜像一并清
  }

  // 清理单源随 store 导出——clearDirtyMirror（docId 级精确删）/ clearBookMirrors（书级
  // 清扫，属主按 payload 精确判定）供文档改名（useChapterTree 的 onRenameCommit /
  // onSaveMeta）、删书（useShelf.confirmDelete）等外部链调用，键格式与降级惯例收敛在
  // shared/dirty-mirror，不再各链自拼 `clw:dirty-mirror:` 键。
  return {
    docs,
    bookName,
    setBook,
    get,
    open,
    patch,
    adoptRenamed,
    clearConflict,
    save,
    waitInflightSave,
    reloadFromRemote,
    overwriteRemote,
    refresh,
    syncCleanWithTree,
    finalize,
    conflictedDirtyDocs,
    flushDirty,
    flushBeforeClose,
    autosaveTick,
    discard,
    clearDirtyMirror: mirror.clearDirtyMirror,
    clearBookMirrors: mirror.clearBookMirrors,
  }
})
