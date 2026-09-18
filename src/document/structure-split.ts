/**
 * 章节结构操作——拆分编排（S4：干跑 plan / 光标校验 / 执行 apply）。
 *
 * R0916-5f（2026-09-16，⑤④产品巨件拆分波2）：自 structure.ts 三缝一体纯移动拆分而来
 * （纯移动——代码与注释原样随迁，零行为变化）。设计口径正本 = structure.ts 头注
 * （《章节结构操作-设计方案-2026-08-30》v3：取号跳定稿/序中值/external-merge 截断
 * 留底）。公共底座（读态派生/plan 指纹/取号/事件副录）在 structure-core.ts，本文件
 * 单向依赖之（core←split，无环）；RAG 触点经 StructureRagPort 端口由组合根注入
 * （G5 依赖反转，零 rag import）。
 *
 * 0918独立重评修复批（B001）：applyChapterSplit 的取号段（状态重读→取号→planHash
 * 复核→截断→新章落位）原无跨请求互斥——两个拆分 apply 并发重叠时各算得同一章号、
 * 目标文件名不同，createDocument 双双成功 → 章号复用。修法 = per-bookRoot 进程内
 * 串行互斥（自实现最小件，链语义对齐 studio/server/serial-chain.ts——document 层
 * 不得 import studio 层）；planChapterSplit（干跑只读）不加锁。
 * 0918三轮修复批（B201）：互斥外侧再加 per-bookRoot **跨进程**锁（既有
 * acquireCrossProcessLockAsync 原语，超时 OCCUPIED 409）——B001 互斥只管进程内，
 * 双进程并发拆分同书仍可静默重号（机理与锁序详注见下方常量段）。
 */
import { dirname, join } from 'node:path'
import { ulid } from '../fs/id.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { stringifyValue } from '../format/frontmatter.js'
import { isPublishedValue } from '../format/chapters.js'
import { sanitizeFileNamePart } from '../format/filename.js'
import { chapterFilePrefix, countWords } from '../format/words.js'
import { isUtf8Bytes, type DocumentService } from './service.js'
import { invalidateTreeIndex } from './tree.js'
import { structureSplitEvent } from '../events/chain-bridge.js'
import {
  fail,
  readChapterState,
  splitPlanHash,
  bodyStartOffset,
  maxUsedChapter,
  finalizedChapterNumbers,
  skipFinalized,
  splitOrderMid,
  recordStructureEvents,
  chapterNoMismatchFailure,
  type ChapterDiskState,
  type StructureFailure,
  type StructureRagPort,
} from './structure-core.js'

// ── 公共形状 ─────────────────────────────────────────────────────────

/** 拆分干跑视图。 */
export interface SplitPlanView {
  ok: true
  op: 'split'
  docId: string
  path: string
  chapterNo: number
  title: string
  /** 新章号 = 全书 max+1 再跳已定稿章号（CC-P1-6 篇号永不复用） */
  newChapterNo: number
  /** 新章显示序 = 拆分点两侧有效序中值 */
  order: number
  /** 光标前保留字数 / 光标后迁出字数（正文口径，不含 fm） */
  headWords: number
  tailWords: number
  tailPreview: string
  /** 原章 fm 已发布 → 提示「平台连载无插入机制」，不硬拦（作者即唯一用户原则） */
  publishedWarning: boolean
  planHash: string
}

export type SplitApplyResult =
  | {
      ok: true
      docId: string
      newDocId: string
      originChapterNo: number
      newChapterNo: number
      order: number
      title: string
    }
  | StructureFailure

// ── 拆分：干跑 + 执行 ────────────────────────────────────────────────

// 0918独立重评修复批（B001）：per-bookRoot 拆分 apply 串行链（进程内互斥最小件，
// 链语义对齐 studio/server/serial-chain.ts 的收编形态——前驱成败都接续、链尾吞错
// 防 unhandled rejection、settle 后身份校验自清理；document 层不 import studio 层）。
// 只串取号临界区，不含 plan 干跑；svc.save/createDocument 的跨进程锁在互斥**内**
// 获取——互斥是进程本地最外层（任何路径都不会持跨进程锁再进入本互斥），与既有
// 三级锁序（save → 布线 → 清单/journal）无环、无倒置。
const splitApplyChains = new Map<string, Promise<unknown>>()

// 0918三轮修复批（B201）：拆分取号临界区的**跨进程**锁——B001 互斥是进程内的，
// 双进程（GUI 服务 + CLI 等合法并存形态）并发拆分同书时两进程可各自扫盘取得同一
// 章号、新章文件名含标题 → 路径不同 → createDocument 独占探测不拦 → 静默重号
//（detectStructureViolations/B004 双轨闸都不查跨文件重号）。修法 = 既有
// acquireCrossProcessLockAsync 原语（analysis/journal 同款）取 per-bookRoot 锁包住
// 进程内链：锁序 = 跨进程 structure 锁 → 进程内链 → save 锁 → 布线 → 清单/journal，
// 一致向外扩展、无环；recordStructureEvents（事件库锁）仍在两把锁**之外**（维持
// B001「互斥内不再获取其他跨进程锁」纪律）。合并/撤销不取新号（留洞制），重号
// 唯一由拆分产生，锁只包拆分即可闭合 B201 机理面。超时 → OCCUPIED（structStatus
// 已有 409 映射，零新增码）；非冲突类故障（EACCES 等）按锁模块契约原样上抛。
const STRUCTURE_OP_LOCK_REL = '工作区/.structure-op.lock'
const STRUCTURE_OP_LOCK_TIMEOUT_MS = 10_000

function enqueueSplitApply<T>(bookRoot: string, unit: () => Promise<T>): Promise<T> {
  const prev = splitApplyChains.get(bookRoot) ?? Promise.resolve()
  const task = prev.then(unit, unit) // 前驱成败都接续（串行不因单元失败断链）
  const settled = task.catch(() => {}) // 链尾吞错副本防 unhandled rejection
  splitApplyChains.set(bookRoot, settled)
  // 链尾自清理：settle 后身份校验 delete（settle 窗口内同 key 新单元的新链尾不误删）
  void settled.then(() => {
    if (splitApplyChains.get(bookRoot) === settled) splitApplyChains.delete(bookRoot)
  })
  return task
}

/** 拆分临界区成功载荷（互斥内产出，互斥外补记事件/清缓存）。 */
interface SplitAppliedCore {
  originChapterNo: number
  newDocId: string
  newChapterNo: number
  order: number
}

export async function planChapterSplit(
  bookRoot: string,
  svc: DocumentService,
  docId: string,
  cursorOffset: number,
): Promise<SplitPlanView | StructureFailure> {
  // B004（0918三拍板批）：入口一致性闸——全书 fm ≡ 文件名号失配即拒（取号下限
  // maxUsedChapter 按文件名号派生，失配盘面上取的号与 fm 语义互相矛盾）
  const gate = chapterNoMismatchFailure(bookRoot)
  if (gate) return gate
  const o = await readChapterState(svc, bookRoot, docId)
  if (!('章号' in o)) return o
  const v = validateSplitCursor(o, cursorOffset)
  if (v !== null) return v
  const newChapterNo = skipFinalized(maxUsedChapter(bookRoot) + 1, finalizedChapterNumbers(bookRoot))
  const order = splitOrderMid(bookRoot, o)
  const fmEnd = bodyStartOffset(o.text)
  const tail = o.text.slice(cursorOffset)
  return {
    ok: true,
    op: 'split',
    docId,
    path: o.path,
    chapterNo: o.章号,
    title: o.标题,
    newChapterNo,
    order,
    headWords: countWords(o.text.slice(fmEnd, cursorOffset)),
    tailWords: countWords(tail),
    tailPreview: canonicalizeText(tail).trim().replace(/\n+/g, ' ').slice(0, 60),
    publishedWarning: isPublishedValue(o.map.get('已发布')),
    planHash: splitPlanHash(o, cursorOffset, newChapterNo, order),
  }
}

/** 拆分点校验：须落在正文内且迁出段非空（光标在 fm 内/文末/尾随空白处 → BAD_INPUT）。 */
function validateSplitCursor(o: ChapterDiskState, cursorOffset: number): StructureFailure | null {
  const fmEnd = bodyStartOffset(o.text)
  if (!Number.isInteger(cursorOffset) || cursorOffset <= fmEnd || cursorOffset >= o.text.length) {
    return fail('BAD_INPUT', `拆分点须落在正文内（第 ${fmEnd + 1} 字符之后且不在文末）`)
  }
  if (o.text.slice(cursorOffset).trim().length === 0) {
    return fail('BAD_INPUT', '拆分点之后没有正文内容（光标在章尾空白处）')
  }
  // 0918独立重评二轮修复批（B101）：UTF-16 代理对边界判定——光标落在高低位代理之间
  //（CJK 扩展 B 生僻字、emoji 等 astral 字符内部）时，apply 的 slice 切分会把一个
  // 字符劈成两个孤立代理，落盘各编码为 U+FFFD（原章尾 + 新章头同时永久损坏一字，
  // 且恢复重放经同一光标复现损坏）。前端编辑器光标通常在码点边界，此处是后端防线。
  const prev = o.text.charCodeAt(cursorOffset - 1)
  const cur = o.text.charCodeAt(cursorOffset)
  if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) {
    return fail('BAD_INPUT', '光标落在字符内部（代理对中间），请移动到字符边界后重试')
  }
  return null
}

export async function applyChapterSplit(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  input: { docId: string; title: string; cursorOffset: number; planHash: string },
  rag: StructureRagPort,
): Promise<SplitApplyResult> {
  const title = input.title.trim()
  if (!title) return fail('BAD_INPUT', '新章标题必填')
  // B004（0918三拍板批）：入口一致性闸（闸在 B001 互斥外——一致性是全书盘面前提，
  // 先于取号临界段拒绝，不带脏盘面进锁）
  const gate = chapterNoMismatchFailure(bookRoot)
  if (gate) return gate
  // B201（0918三轮修复批）：跨进程锁（外层，闸外/进程内链外）——双进程并发拆分
  // 同书的取号互斥；超时按 OCCUPIED fail-loud（并发对手在位，重试即可）。
  const releaseStructureLock = await acquireCrossProcessLockAsync(
    join(bookRoot, STRUCTURE_OP_LOCK_REL),
    STRUCTURE_OP_LOCK_TIMEOUT_MS,
  )
  if (releaseStructureLock === null) {
    return fail(
      'OCCUPIED',
      `本书结构操作跨进程锁等待超时（${STRUCTURE_OP_LOCK_TIMEOUT_MS}ms）——另一进程可能正在执行拆分/合并，请稍后重试`,
    )
  }
  // 0918独立重评修复批（B001）：取号临界区（状态重读 → validateSplitCursor → 取号 →
  // planHash 复核 → svc.save 截断 → createDocument）整段置于 per-bookRoot 串行互斥内
  // ——并发第二个 apply 在锁内重读取号得新号 → hash 失配 → PLAN_STALE fail-loud
  //（这正是期望行为），章号永不复用。锁作用域内只 await 盘面读写与 svc 既有有界锁
  // 操作；事件副录（recordStructureEvents 内部自取事件库跨进程 open 锁）留在锁外，
  // 满足「互斥内不再获取其他跨进程锁」的锁序纪律。
  let core: SplitAppliedCore | StructureFailure
  try {
    core = await enqueueSplitApply(
      bookRoot,
      async (): Promise<SplitAppliedCore | StructureFailure> => {
        const o = await readChapterState(svc, bookRoot, input.docId)
        if (!('章号' in o)) return o
        const v = validateSplitCursor(o, input.cursorOffset)
        if (v !== null) return v
        const newChapterNo = skipFinalized(maxUsedChapter(bookRoot) + 1, finalizedChapterNumbers(bookRoot))
        const order = splitOrderMid(bookRoot, o)
        const planHash = splitPlanHash(o, input.cursorOffset, newChapterNo, order)
        if (planHash !== input.planHash) {
          return fail('PLAN_STALE', '干跑后正文或章号基线已变化，请重新预览确认后再执行')
        }
        if (!isUtf8Bytes(o.bytes)) {
          return fail('NOT_UTF8_TARGET', '该章是非 UTF-8 编码的存量文件（GBK 等旧档），拆分会失真——请先在编辑器外转码为 UTF-8 再操作')
        }
        // ① 原章截断（external-merge 强制留底 = 截断前全文，反悔可回）
        const head = `${o.text.slice(0, input.cursorOffset).trimEnd()}\n`
        const tail = canonicalizeText(o.text.slice(input.cursorOffset)).trimStart()
        const saved = await svc.save(input.docId, o.path, {
          content: head,
          expectedRevision: o.rev,
          operationId: ulid(),
          origin: 'external-merge',
          reason: `拆分第${o.章号}章：光标后内容迁出为第${newChapterNo}章`,
        })
        if (!saved.ok) return fail(saved.code, saved.reason)
        // ② 新章落位（与原章同目录——卷归属随原章；文件名 sanitizeFileNamePart +
        // chapterFilePrefix 单源；fm 序 = 两侧有效序中值）。win 合并批（2026-09-13）：
        // 仓库 relPath 正斜杠为规范形——win 的 path.join 产出反斜杠，会把整条路径带进
        // doCreate 的单段消毒被洗成畸形文件名落书根（apply 200 但预期路径无文件）；
        // 规范化与下方 detectStructureViolations 的 replaceAll 同款（macOS 上恒 no-op）。
        const relPath = join(dirname(o.path), `${chapterFilePrefix(newChapterNo, 'chapter')}${sanitizeFileNamePart(title)}.md`).replaceAll('\\', '/')
        const newContent = `---\n章号: ${newChapterNo}\n标题: ${stringifyValue(title)}\n序: ${order}\n---\n${tail}${tail.endsWith('\n') ? '' : '\n'}`
        const created = await svc.createDocument({ relPath, content: newContent })
        if (!created.ok) {
          return fail(
            created.code,
            `原章已截断（截断前全文已留底为版本），但新章创建失败：${created.reason}——可重试拆分或从版本面板恢复原章`,
          )
        }
        return { originChapterNo: o.章号, newDocId: created.docId, newChapterNo, order }
      },
    )
  } finally {
    releaseStructureLock()
  }
  if (!('originChapterNo' in core)) return core
  // ③ 事件 + ④ RAG 指纹失效（原章内容已变，下轮 buildIndex 重嵌两章）+ ⑤ 缓存失效
  //（B001：互斥外——事件副录自取事件库跨进程锁，不进取号互斥作用域）
  await recordStructureEvents(userDataPath, bookRoot, [
    structureSplitEvent({
      op: 'split',
      docId: input.docId,
      newDocId: core.newDocId,
      originChapterNo: core.originChapterNo,
      newChapterNo: core.newChapterNo,
      order: core.order,
      title,
    }),
  ])
  rag.cleanupRagAfterMerge(bookRoot, [], core.originChapterNo)
  invalidateTreeIndex(bookRoot, true)
  return {
    ok: true,
    docId: input.docId,
    newDocId: core.newDocId,
    originChapterNo: core.originChapterNo,
    newChapterNo: core.newChapterNo,
    order: core.order,
    title,
  }
}
