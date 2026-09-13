/**
 * 阶段 24 章节结构操作（合并/拆分/撤销合并）——编排层（S3+S4）。
 *
 * 设计口径 = 《章节结构操作-设计方案-2026-08-30》（v3，D1-D7 已拍板）：
 * - 留洞制：章号 append-only 永不改指；被合并章软删进回收站，去向记录在目标章
 *   fm `并入: number[]`（写侧链式折叠单跳化——11 并 12,13 时源 13 直接重指向 11）。
 * - 文件本位：真实存储文件是唯一权威，事件库只做审计副录（undo 定位主路径）。
 * - 崩溃不变量：「并入 所指章不得存活于正文」。合并两步（①目标章写入 ②源章软删）
 *   顺序执行各取各放（锁序：不自造并行持双 docId 锁的编排——svc.save 自取目标
 *   save 锁、trashDocument 自取源 save 锁 + 内嵌清单/trash RMW，天然无环）；undo 顺序
 *   （①目标章版本回滚 ②还原源章）保证中途态永不违反不变量。
 * - 写入通道 = svc.save origin 'external-merge'（白名单既有 + 强制留底快照 =
 *   rollbackSnapshotId；禁止绕开它裸 atomicWriteFile——会失去保存锁/锁内复核
 *   R76-22/journal 闭环三件套）。
 *
 * 干跑（plan）只读：encodingSuspect 预检 + 拼接摘要 + 履历引文命中率预演 +
 * RAG 清除预估 + plan 指纹（apply 复核防 TOCTOU）。apply 幂等续跑：目标 fm 已含
 * 源章号且回收站在档 = ①后崩溃半成态，跳过写入直续 ②③④⑤。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { ulid } from '../fs/id.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { readMdTextCached } from '../fs/md-text-cache.js'
import { walkMdEach } from '../fs/walk-md.js'
import { safeManifestPath } from '../fs/safe-path.js'
import { splitFrontMatter, parseFlat, patchFlatFm, stringifyValue } from '../format/frontmatter.js'
import { parseMergedInto, parseOrderOf, isPublishedValue } from '../format/chapters.js'
import { mergedIntoMap } from '../format/chapter-lookup.js'
import { chapterNoFromName, sanitizeFileNamePart } from '../format/filename.js'
import { chapterFilePrefix, countWords } from '../format/words.js'
import { layoutOf } from './layout.js'
import { readManifestStrict } from './manifest.js'
import { invalidateTreeIndex } from './tree.js'
import { readVersion, readVersionRaw, listVersions } from './version.js'
import { restoreTrash, listTrash } from './trash.js'
import { isUtf8Bytes, type DocumentService } from './service.js'
import { readChapterUpdatesForChapter, leadEvidenceMatchesBody } from '../check/lead-updates.js'
import { openSessionStoreAsync, bookHash, type NewEvent, type SessionStore } from '../events/store.js'
import { structureMergeEvent, structureSplitEvent, structureMergeUndoEvent } from '../events/chain-bridge.js'
import type { StructureMergeData, StructureMergeUndoData } from '../events/types.js'
import { log } from '../log/index.js'

// ── 公共形状 ─────────────────────────────────────────────────────────

export type StructureFailure = { ok: false; code: string; reason: string }

/**
 * RAG 触点端口（G5 依赖方向守护的接口反转）：document 底座不得 import rag 生成层，
 * 干跑预估与合并后清理由合法调用层（studio/server/api）注入 rag/index 实现。方法名
 * 与被代理函数一致（适配零成本）；等价性由 structure-merge/split 端点级 RAG 用例钉定
 * （经 api 层走真实现，本文件零 rag 依赖可独立单测）。
 */
export interface StructureRagPort {
  estimateRagChunkCount(bookRoot: string, chapters: number[]): number
  cleanupRagAfterMerge(bookRoot: string, sourceChapterNos: number[], targetChapterNo: number): void
}

/** 合并干跑视图（前端确认弹窗数据源）。 */
export interface MergePlanView {
  ok: true
  op: 'merge'
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  targetPath: string
  sourcePath: string
  targetTitle: string
  sourceTitle: string
  /** 任一方非 UTF-8（GBK 存量）——apply 将 400 拒绝（NOT_UTF8_TARGET 家族口径） */
  encodingSuspect: boolean
  sourceWords: number
  /** 源章正文首段预览（截断） */
  sourcePreview: string
  /** 折叠后目标章 fm 并入 数组（写侧单跳化） */
  mergedInto: number[]
  /** 源章履历引文对拼接正文的命中预演（false 项合并后将产 lead-evidence-miss 红） */
  leadPreviews: Array<{ leadId: string; 动词: string; 证据: string; willMatch: boolean }>
  /** 源章 RAG 向量块清除预估 */
  ragChunksToClear: number
  planHash: string
}

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

export type MergeApplyResult =
  | {
      ok: true
      targetDocId: string
      sourceDocId: string
      targetChapterNo: number
      sourceChapterNo: number
      mergedInto: number[]
      /** = 源 docId（TrashEntry.id 即原 docId） */
      trashEntryId: string
      rollbackSnapshotId?: string
      planHash: string
    }
  | StructureFailure

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

export type MergeUndoResult =
  | { ok: true; targetDocId: string; sourceDocId: string; sourceChapterNo: number; trashEntryId: string; planHash: string }
  | StructureFailure

// ── 内部工具 ─────────────────────────────────────────────────────────

const BODY_PREFIX = '写作/正文/'
const VERSIONS_DIR_REL = '工作区/.版本'

/** 单读派生：章文件盘上状态（字节 → revision / UTF-8 判定 / fm+正文 三路同源，
 *  R33D-18/R48-43 消除重复整读与读间 TOCTOU 的同款口径）。 */
interface ChapterDiskState {
  path: string
  abs: string
  bytes: Buffer
  rev: `sha256:${string}`
  text: string
  fmRaw: string
  body: string
  map: Map<string, unknown>
  章号: number
  标题: string
  序?: number
  并入: number[]
}

function fail(code: string, reason: string): StructureFailure {
  return { ok: false, code, reason }
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 读章文件盘上状态；未登记/非正文章/fm 坏 → 结构化失败。 */
async function readChapterState(
  svc: DocumentService,
  bookRoot: string,
  docId: string,
): Promise<ChapterDiskState | StructureFailure> {
  const path = await svc.resolvePathAsync(docId)
  if (!path) return fail('NOT_FOUND', `文档ID未在清单登记：${docId}`)
  if (!path.startsWith(BODY_PREFIX)) return fail('BAD_INPUT', `目标不是正文区章文件：${path}`)
  if (layoutOf(path).role !== 'chapter') return fail('BAD_INPUT', `目标不是章文档：${path}`)
  // 复审-0913-源码 P2-1：清单路径可篡改数据面 defense-in-depth——resolvePathAsync 产出的
  // path 裸 join 前经 safeManifestPath 收口（越界/非法 → BAD_INPUT 拒收，不留书外探测面）
  const abs = safeManifestPath(bookRoot, path)
  if (!abs) return fail('BAD_INPUT', `清单路径越界或非法：${path}`)
  if (!existsSync(abs)) return fail('NOT_FOUND', `源文件不存在：${path}`)
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (e) {
    return fail('WRITE_ERROR', `读 ${path} 失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const rev = `sha256:${sha256Hex(bytes)}` as `sha256:${string}`
  const text = bytes.toString('utf-8')
  const split = splitFrontMatter(text)
  if (!split) return fail('BAD_INPUT', `${path} 无 frontmatter 或未闭合（章文件须带 fm）`)
  const map = parseFlat(split.fmRaw)
  const no = Number(map.get('章号'))
  if (!Number.isInteger(no) || no < 1) return fail('BAD_INPUT', `${path} fm 章号缺失或非法`)
  const state: ChapterDiskState = {
    path,
    abs,
    bytes,
    rev,
    text,
    fmRaw: split.fmRaw,
    body: split.body,
    map,
    章号: no,
    标题: typeof map.get('标题') === 'string' ? (map.get('标题') as string) : '',
    并入: parseMergedInto(map.get('并入')) ?? [],
  }
  const order = parseOrderOf(map.get('序'))
  if (order !== undefined) state.序 = order
  return state
}

/** plan 指纹：参数 + 双方 fm/正文哈希——apply 复核防 TOCTOU（干跑确认窗口内世界已变即拒）。 */
function mergePlanHash(target: ChapterDiskState, source: ChapterDiskState, mergedInto: number[]): string {
  return sha256Hex(JSON.stringify({ op: 'merge', t: target.path, s: source.path, tr: target.rev, sr: source.rev, m: mergedInto }))
}

function splitPlanHash(o: ChapterDiskState, cursorOffset: number, newChapterNo: number, order: number): string {
  return sha256Hex(JSON.stringify({ op: 'split', p: o.path, r: o.rev, c: cursorOffset, n: newChapterNo, o: order }))
}

/** 合并折叠：目标既有 并入 ∪ {源章号} ∪ 源自身 并入（链式单跳化），排序去重。 */
function foldMergedInto(target: ChapterDiskState, source: ChapterDiskState): number[] {
  return [...new Set([...target.并入, source.章号, ...source.并入])].sort((a, b) => a - b)
}

/** 拼接规范形（§三.11）：canonicalize(目标正文) + 空行分隔 + canonicalize(源正文)
 *  ——与 save 链规范形一致，避免拼接缝产生机检伪红。 */
function concatChapterBody(target: ChapterDiskState, source: ChapterDiskState): string {
  return `${canonicalizeText(target.body).trimEnd()}\n\n${canonicalizeText(source.body).trimStart()}`
}

/** 正文起始偏移（splitFrontMatter 同款 fence 判定；无 fm → 0）。 */
function bodyStartOffset(text: string): number {
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i]!)) return lines.slice(0, i + 1).join('\n').length + 1
  }
  return 0
}

/** 事件副录（审计层）：写失败 warn 不阻断主流程（文件本位——盘上状态是权威）。 */
async function recordStructureEvents(userDataPath: string | null, bookRoot: string, events: NewEvent[]): Promise<void> {
  if (!userDataPath || events.length === 0) return
  let store: SessionStore | null = null
  try {
    store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      store.appendEvents(sessionId, events)
    } finally {
      store.close()
    }
  } catch (e) {
    log.warn('structure', `结构操作事件副录失败（${events.map((e2) => e2.type).join(',')}，审计链缺段；盘上状态不受影响）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 全书已用最大章号：正文区文件名章号 + 并入 在档源章号（合并产生的洞也是「已用」，
 *  新章号永不回头填洞——留洞制 D1）。 */
function maxUsedChapter(bookRoot: string): number {
  let max = 0
  const bodyDir = join(bookRoot, BODY_PREFIX)
  if (existsSync(bodyDir)) {
    walkMdEach(bodyDir, (_fp, name) => {
      const n = chapterNoFromName(name)
      if (n !== null && n > max) max = n
    })
  }
  for (const src of mergedIntoMap(bookRoot).keys()) {
    if (src > max) max = src
  }
  return max
}

/** 已定稿章号集合（manifest finalizedRevision 条目，路径章号派生；state.ts
 *  skipFinalizedChapters 同语义）。strict 读失败上抛——取号错比拒绝执行更贵
 *  （fail-closed，调用方收 WRITE_ERROR 信封）。 */
function finalizedChapterNumbers(bookRoot: string): Set<number> {
  const out = new Set<number>()
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return out
  const m = readManifestStrict(manifestPath)
  for (const e of m.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    const n = chapterNoFromName(basename(e.path))
    if (n !== null) out.add(n)
  }
  return out
}

/** CC-P1-6：n 起步跳过一切已定稿章号（「篇号永不复用」语义；连续定稿时 n+1 即空闲）。 */
function skipFinalized(n: number, finalized: Set<number>): number {
  let next = n
  while (finalized.has(next)) next++
  return next
}

/** 新章显示序：拆分点两侧有效序中值——原章有效序与其在显示序中后继章有效序的中点；
 *  原章是显示序末章时 +0.5（严格大于原章、小于任何后续追加章的缺省序）。 */
function splitOrderMid(bookRoot: string, origin: ChapterDiskState): number {
  const selfOrder = origin.序 ?? origin.章号
  const selfReal = realpathOf(origin.abs)
  let next = Infinity
  const bodyDir = join(bookRoot, BODY_PREFIX)
  if (existsSync(bodyDir)) {
    // 与 tree.ts sortTreeByOrder 同口径：序 ?? 文件名章号（readMdTextCached 复用指纹缓存）
    walkMdEach(bodyDir, (fp, name) => {
      if (realpathOf(fp) === selfReal) return
      const n = chapterNoFromName(name)
      if (n === null) return
      let ord: number = n
      const raw = readMdTextCached(fp)
      const sp = raw === null ? null : splitFrontMatter(raw)
      if (sp) {
        const om = parseOrderOf(parseFlat(sp.fmRaw).get('序'))
        if (om !== undefined) ord = om
      }
      if (ord > selfOrder && ord < next) next = ord
    })
  }
  return next === Infinity ? selfOrder + 0.5 : (selfOrder + next) / 2
}

function realpathOf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 版本推演：目标章最新一个「fm 并入 不含源章号」的版本 id（崩溃续跑 / 降级 undo
 *  定位 rollbackSnapshotId 用——正常路径由 save 前后版本集差分得出，此为世界已变
 *  或事件缺失时的兜底；推演自带「并入 不含源」校验，天然排除合并后版本）。 */
function newestVersionWithoutSource(bookRoot: string, docId: string, sourceChapterNo: number): string | null {
  const versionsDir = join(bookRoot, VERSIONS_DIR_REL)
  for (const v of listVersions(versionsDir, docId)) {
    const snap = readVersion(versionsDir, docId, v.id)
    if (!snap) continue
    const sp = splitFrontMatter(snap.content)
    if (!sp) return v.id // 无 fm 的更旧形态必在并入 机制之前
    const merged = parseMergedInto(parseFlat(sp.fmRaw).get('并入')) ?? []
    if (!merged.includes(sourceChapterNo)) return v.id
  }
  return null
}

// ── 合并：干跑 ───────────────────────────────────────────────────────

export async function planChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  targetDocId: string,
  sourceDocId: string,
  rag: StructureRagPort,
): Promise<MergePlanView | StructureFailure> {
  if (targetDocId === sourceDocId) return fail('BAD_INPUT', '目标章与源章不能是同一章')
  const t = await readChapterState(svc, bookRoot, targetDocId)
  if (!('章号' in t)) return t
  const s = await readChapterState(svc, bookRoot, sourceDocId)
  if (!('章号' in s)) return s
  if (s.章号 === t.章号) return fail('BAD_INPUT', `跨卷重号章（章号 ${s.章号}）不可合并——请先修正章号`)
  const mergedInto = foldMergedInto(t, s)
  const concatBody = concatChapterBody(t, s)
  const leadPreviews = readChapterUpdatesForChapter(bookRoot, s.章号).map((u) => ({
    leadId: u.leadId,
    动词: u.动词,
    证据: u.证据,
    willMatch: leadEvidenceMatchesBody(concatBody, u.证据),
  }))
  return {
    ok: true,
    op: 'merge',
    targetDocId,
    sourceDocId,
    targetChapterNo: t.章号,
    sourceChapterNo: s.章号,
    targetPath: t.path,
    sourcePath: s.path,
    targetTitle: t.标题,
    sourceTitle: s.标题,
    encodingSuspect: !isUtf8Bytes(t.bytes) || !isUtf8Bytes(s.bytes),
    sourceWords: countWords(s.body),
    sourcePreview: canonicalizeText(s.body).trim().replace(/\n+/g, ' ').slice(0, 60),
    mergedInto,
    leadPreviews,
    ragChunksToClear: rag.estimateRagChunkCount(bookRoot, [s.章号]),
    planHash: mergePlanHash(t, s, mergedInto),
  }
}

// ── 合并：执行 ───────────────────────────────────────────────────────

export async function applyChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  input: { targetDocId: string; sourceDocId: string; planHash: string },
  rag: StructureRagPort,
): Promise<MergeApplyResult> {
  if (input.targetDocId === input.sourceDocId) return fail('BAD_INPUT', '目标章与源章不能是同一章')
  const t = await readChapterState(svc, bookRoot, input.targetDocId)
  if (!('章号' in t)) return t
  // S5 崩溃形态分流前移（设计方案 §5.5 repair 判定式）：fm `并入` 已含源章号 = ① 已
  // 落定，此后任何中断都是收尾段半途态，重跑 apply 即幂等收敛。②后崩溃形态（源章已
  // 软删、清单条目已摘）readChapterState(源) 必失败，故先查回收站条目再读源章。
  const trashEntry = listTrash(bookRoot).find((e) => e.id === input.sourceDocId)
  if (trashEntry) {
    // ②后崩溃形态：源章已进回收站（文件在 .trash、清单条目已摘）——章号从条目
    // originalPath 反推，须与 fm 并入 对应；trash 段已落定，finishMerge 内部自查跳过。
    const no = chapterNoFromName(basename(trashEntry.originalPath))
    if (no === null || !t.并入.includes(no)) {
      return fail('NOT_MERGE_STATE', `回收站条目与目标章 fm 并入 不对应（章号 ${no ?? '无法解析'}，并入 = ${t.并入.join(',') || '空'}）——疑似人工处置过，请先「撤销合并」或手工核对盘面`)
    }
    const rollbackSnapshotId = newestVersionWithoutSource(bookRoot, input.targetDocId, no) ?? undefined
    const resumed: MergeApplyResult = {
      ok: true,
      targetDocId: input.targetDocId,
      sourceDocId: input.sourceDocId,
      targetChapterNo: t.章号,
      sourceChapterNo: no,
      mergedInto: t.并入,
      trashEntryId: input.sourceDocId,
      ...(rollbackSnapshotId !== undefined ? { rollbackSnapshotId } : {}),
      planHash: input.planHash,
    }
    return finishMerge(bookRoot, svc, userDataPath, null, resumed, rag)
  }
  const s = await readChapterState(svc, bookRoot, input.sourceDocId)
  if (!('章号' in s)) return s
  if (s.章号 === t.章号) return fail('BAD_INPUT', `跨卷重号章（章号 ${s.章号}）不可合并——请先修正章号`)
  const mergedInto = foldMergedInto(t, s)

  if (t.并入.includes(s.章号)) {
    // ①后崩溃形态：fm 已含源章号且源章仍存活正文（② 软删未起或中途被打断，内容暂
    // 重复可见）——重跑 = 幂等续跑，跳过 planHash/编码复核（① 已通过），直接补完
    // 收尾段；回收站无条目 + 源章不在正文 = 半成态已被人工处置，语义歧义拒收交作者
    // 先走撤销。
    // 复审-0913-源码 P2-1：s.abs 已是 readChapterState 经 safeManifestPath 收口的派生，
    // 不再二次裸 join
    if (!existsSync(s.abs)) {
      return fail('NOT_MERGE_STATE', `目标章 fm 并入 已含第${s.章号}章，但源章既不在正文也不在回收站（半成态疑似已被人工处置）——请先「撤销合并」清理 fm，或手工修正 并入 登记`)
    }
    const rollbackSnapshotId = newestVersionWithoutSource(bookRoot, input.targetDocId, s.章号) ?? undefined
    const resumed: MergeApplyResult = {
      ok: true,
      targetDocId: input.targetDocId,
      sourceDocId: input.sourceDocId,
      targetChapterNo: t.章号,
      sourceChapterNo: s.章号,
      mergedInto,
      trashEntryId: input.sourceDocId,
      ...(rollbackSnapshotId !== undefined ? { rollbackSnapshotId } : {}),
      planHash: input.planHash,
    }
    return finishMerge(bookRoot, svc, userDataPath, s, resumed, rag)
  }

  // TOCTOU 复核：干跑指纹重算比对（等锁/确认窗口内他保存/移动即拒，重新干跑）
  const planHash = mergePlanHash(t, s, mergedInto)
  if (planHash !== input.planHash) {
    return fail('PLAN_STALE', '干跑后正文已变化（或章文件被移动/改名），请重新预览确认后再执行')
  }
  if (!isUtf8Bytes(t.bytes) || !isUtf8Bytes(s.bytes)) {
    return fail('NOT_UTF8_TARGET', '合并涉及非 UTF-8 编码的存量章（GBK 等旧档），拼接会失真——请先在编辑器外转码为 UTF-8 再操作')
  }
  // ① 目标章正文并入：新 fm = patchFlatFm(原 fm, {并入})（其余键行逐字节保形，含
  // _raw 已发布）+ 拼接正文；external-merge 强制留底快照 = rollbackSnapshotId。
  const patched = patchFlatFm(t.fmRaw, { 并入: mergedInto })
  if (!patched.ok) return fail('BAD_INPUT', `目标章 frontmatter 改写被拒：${patched.reason}`)
  let content = `---\n${patched.text}\n---\n${concatChapterBody(t, s)}`
  if (!content.endsWith('\n')) content += '\n'
  const versionsDir = join(bookRoot, VERSIONS_DIR_REL)
  const before = new Set(listVersions(versionsDir, input.targetDocId).map((v) => v.id))
  const saved = await svc.save(input.targetDocId, t.path, {
    content,
    expectedRevision: t.rev,
    operationId: ulid(),
    origin: 'external-merge',
    reason: `合并第${s.章号}章进第${t.章号}章（结构操作）`,
  })
  if (!saved.ok) return fail(saved.code, saved.reason)
  // save 后新增的最新版本 = external-merge 覆盖前留底（合并前内容）；快照罕见缺失时
  // 缺省——undo 定位走版本推演兜底
  const rollbackSnapshotId = listVersions(versionsDir, input.targetDocId).find((v) => !before.has(v.id))?.id
  const merged: MergeApplyResult = {
    ok: true,
    targetDocId: input.targetDocId,
    sourceDocId: input.sourceDocId,
    targetChapterNo: t.章号,
    sourceChapterNo: s.章号,
    mergedInto,
    trashEntryId: input.sourceDocId,
    ...(rollbackSnapshotId !== undefined ? { rollbackSnapshotId } : {}),
    planHash,
  }
  return finishMerge(bookRoot, svc, userDataPath, s, merged, rag)
}

/** 合并收尾段（②软删 + ③事件 + ④RAG + ⑤缓存失效）——新执行与幂等续跑共用。
 *  source 仅用于类型收窄语义（②后崩溃续跑形态源章盘面态不可读传 null）。 */
async function finishMerge(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  _source: ChapterDiskState | null,
  merged: Extract<MergeApplyResult, { ok: true }>,
  rag: StructureRagPort,
): Promise<MergeApplyResult> {
  // ② 源章软删：svc.trashDocument 既有管线（自取源 docId save 锁 + trashBaselineOf
  // RMW 基线落账）；TrashEntry.id = 源 docId。S5 幂等：②后崩溃续跑形态源章已在
  // 回收站（trash 段已落定），自查跳过不再二次软删——判据 = 条目在档**且**源文件
  // 确已不在原路径（文件被人工放回正文的混合态仍需补软删，跳过会让 并入 所指章
  // 永久存活、违反崩溃不变量）。
  const trashEntry = listTrash(bookRoot).find((e) => e.id === merged.sourceDocId)
  // 复审-0913-源码 P2-1：回收站条目 originalPath 同为清单派生可篡改面（trash.ts 恢复段
  // 已走 safePathWithin，此处存在性探测同源收口）；路径非法不可判 → NOT_MERGE_STATE 交
  // 作者（fail-closed：既不误判已软删跳过，也不落「进回收站失败」重试空转）
  const srcAbs = trashEntry === undefined ? null : safeManifestPath(bookRoot, trashEntry.originalPath)
  if (trashEntry !== undefined && srcAbs === null) {
    return fail('NOT_MERGE_STATE', `回收站条目 originalPath 越界或非法（${trashEntry.originalPath}）——疑似人工处置过，请先「撤销合并」或手工核对盘面`)
  }
  const alreadyTrashed = srcAbs !== null && !existsSync(srcAbs)
  if (!alreadyTrashed) {
    const trashed = await svc.trashDocument({ docId: merged.sourceDocId })
    if (!trashed.ok) {
      return fail(
        trashed.code,
        `目标章已并入（fm 并入 已登记），但源章进回收站失败：${trashed.reason}——重试将自动续跑收尾，或「撤销合并」回退`,
      )
    }
  }
  // ③ 事件副录（审计）
  await recordStructureEvents(userDataPath, bookRoot, [
    structureMergeEvent({
      op: 'merge',
      targetDocId: merged.targetDocId,
      sourceDocId: merged.sourceDocId,
      targetChapterNo: merged.targetChapterNo,
      sourceChapterNo: merged.sourceChapterNo,
      mergedInto: merged.mergedInto,
      trashEntryId: merged.trashEntryId,
      ...(merged.rollbackSnapshotId !== undefined ? { rollbackSnapshotId: merged.rollbackSnapshotId } : {}),
      planHash: merged.planHash,
    }),
  ])
  // ④ RAG 清理（best-effort 不阻断：下轮 buildIndex 的残留清理 + stale/missing 指纹自愈兜底）
  rag.cleanupRagAfterMerge(bookRoot, [merged.sourceChapterNo], merged.targetChapterNo)
  // ⑤ 缓存失效（trash 管线已失效一次；目标章内容变更侧显式再失效，structural）
  invalidateTreeIndex(bookRoot, true)
  return merged
}

// ── 撤销合并 ─────────────────────────────────────────────────────────

interface MergeUndoLocator {
  sourceDocId: string
  sourceChapterNo: number
  trashEntryId: string
  rollbackSnapshotId?: string
  planHash: string
}

/** undo 端点的调用方回传提示（apply 响应原样透传）——三 id 齐备时直用（仍按 并入 校验）。 */
export interface MergeUndoHints {
  sourceDocId?: string
  sourceChapterNo?: number
  trashEntryId?: string
  rollbackSnapshotId?: string
  planHash?: string
}

/** 事件主路径：最近一条未被 structure.merge-undo 撤销的 structure.merge（按 targetDocId）。 */
async function locateLatestMergeEvent(
  userDataPath: string | null,
  bookRoot: string,
  targetDocId: string,
): Promise<MergeUndoLocator | null> {
  if (!userDataPath) return null
  let store: SessionStore | null = null
  try {
    store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return null
  } catch {
    return null
  }
  try {
    const undone = new Set<string>()
    let found: MergeUndoLocator | null = null
    for (const ev of store.iterateEvents(bookHash(bookRoot), undefined, undefined)) {
      if (ev.type === 'structure.merge-undo') {
        const ph = (ev.data as Record<string, unknown>)['planHash']
        if (typeof ph === 'string') undone.add(ph)
      } else if (ev.type === 'structure.merge') {
        const d = ev.data as unknown as StructureMergeData
        if (d.targetDocId === targetDocId && !undone.has(d.planHash)) {
          found = {
            sourceDocId: d.sourceDocId,
            sourceChapterNo: d.sourceChapterNo,
            trashEntryId: d.trashEntryId,
            ...(d.rollbackSnapshotId !== undefined ? { rollbackSnapshotId: d.rollbackSnapshotId } : {}),
            planHash: d.planHash,
          }
        }
      }
    }
    return found
  } finally {
    store.close()
  }
}

/** 降级路径（无事件库/无匹配）：fm 并入 最大源章号 + 回收站按 originalPath 反查 +
 *  rollbackSnapshotId 走版本推演（newestVersionWithoutSource）。失配返回 null 交上层拒。 */
function locateMergeByDisk(bookRoot: string, mergedInto: number[]): MergeUndoLocator | null {
  if (mergedInto.length === 0) return null
  const sourceChapterNo = Math.max(...mergedInto)
  for (const e of listTrash(bookRoot)) {
    if (chapterNoFromName(basename(e.originalPath)) === sourceChapterNo) {
      return { sourceDocId: e.id, sourceChapterNo, trashEntryId: e.id, planHash: '' }
    }
  }
  return null
}

/** S5 正文盘面定位（①后崩溃形态专用）：merge 事件（收尾段才记）与回收站条目（② 才
 *  产生）都缺，源章仍存活正文——按清单条目路径章号反查 docId；trashEntryId 留空，
 *  undo 的还原段据此跳过（源章无需还原）。strict 读失败按 null 走 NOT_MERGE_STATE
 *  拒收（定位失败与「不是合并态」对调用方等价，不上抛炸端点）。 */
function locateMergeByBody(bookRoot: string, mergedInto: number[]): MergeUndoLocator | null {
  if (mergedInto.length === 0) return null
  const sourceChapterNo = Math.max(...mergedInto)
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return null
  let m: ReturnType<typeof readManifestStrict>
  try {
    m = readManifestStrict(manifestPath)
  } catch {
    return null
  }
  for (const [id, e] of m.entries) {
    if (e.nodeType !== 'document') continue
    if (chapterNoFromName(basename(e.path)) !== sourceChapterNo) continue
    // 复审-0913-源码 P2-1：清单条目 path 同源收口（越界/非法条目不探测，等同未命中）
    const abs = safeManifestPath(bookRoot, e.path)
    if (abs !== null && existsSync(abs)) {
      return { sourceDocId: id, sourceChapterNo, trashEntryId: '', planHash: '' }
    }
  }
  return null
}

export async function undoChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  targetDocId: string,
  rag: StructureRagPort,
  hints?: MergeUndoHints,
): Promise<MergeUndoResult> {
  const t = await readChapterState(svc, bookRoot, targetDocId)
  if (!('章号' in t)) return t
  if (t.并入.length === 0) {
    return fail('NOT_MERGE_STATE', '该章 fm 无 并入 登记（不是合并目标或已撤销）')
  }
  let loc: MergeUndoLocator | null = null
  if (
    hints?.sourceDocId !== undefined &&
    hints.sourceChapterNo !== undefined &&
    hints.trashEntryId !== undefined
  ) {
    loc = {
      sourceDocId: hints.sourceDocId,
      sourceChapterNo: hints.sourceChapterNo,
      trashEntryId: hints.trashEntryId,
      ...(hints.rollbackSnapshotId !== undefined ? { rollbackSnapshotId: hints.rollbackSnapshotId } : {}),
      planHash: hints.planHash ?? '',
    }
  }
  if (loc === null) loc = await locateLatestMergeEvent(userDataPath, bookRoot, targetDocId)
  if (loc === null) loc = locateMergeByDisk(bookRoot, t.并入)
  if (loc === null) loc = locateMergeByBody(bookRoot, t.并入)
  if (loc === null) {
    return fail('NOT_MERGE_STATE', '找不到可撤销的合并记录（事件副录缺失且回收站无对应条目）')
  }
  if (!t.并入.includes(loc.sourceChapterNo)) {
    return fail('NOT_MERGE_STATE', `目标章 fm 并入（${t.并入.join(',')}）不含源章 ${loc.sourceChapterNo}——盘面与合并记录不符，请人工核对`)
  }
  const versionsDir = join(bookRoot, VERSIONS_DIR_REL)
  // rollbackSnapshotId 缺失/读取失败时版本推演兜底（推演自带「并入 不含源」校验）
  let rollbackId = loc.rollbackSnapshotId
  if (rollbackId === undefined || readVersionRaw(versionsDir, targetDocId, rollbackId) === null) {
    rollbackId = newestVersionWithoutSource(bookRoot, targetDocId, loc.sourceChapterNo) ?? undefined
  }
  if (rollbackId === undefined) {
    return fail('UNDO_NO_SNAPSHOT', '找不到合并前的留底版本（快照缺失），无法自动回滚——请在版本面板手工恢复合并前版本，再从回收站还原源章')
  }
  const snap = readVersionRaw(versionsDir, targetDocId, rollbackId)
  if (!snap) return fail('UNDO_NO_SNAPSHOT', `留底版本 ${rollbackId} 读取失败`)
  const content: string | Buffer = isUtf8Bytes(snap.content) ? snap.content.toString('utf-8') : snap.content
  // ① 目标章版本回滚：origin 'restore' 强制留底——「合并后作者新修改」先留底成版本
  // 不丢；fm 随内容整体回滚，并入 键自然消失（patchFlatFm 无删键缺口就此消解）。
  // 中途态不变量：此刻源章仍在回收站，「并入 所指章不存活」未违反。
  if (!existsSync(t.abs)) return fail('NOT_FOUND', `目标章文件不存在：${t.path}`)
  const rolled = await svc.save(targetDocId, t.path, {
    content,
    // 复审-0913-源码 P3-②：用 readChapterState 单读派生的 t.rev（R33D-18 单读同款口径）
    // ——消整读重算；读后文件被并发改 → revision 冲突拒收（fail-closed），不静默按新基线写入
    expectedRevision: t.rev,
    operationId: ulid(),
    origin: 'restore',
    reason: `撤销合并：回滚第${loc.sourceChapterNo}章并入前版本`,
  })
  if (!rolled.ok) return fail(rolled.code, rolled.reason)
  // ② 还原源章：S5 ①后崩溃形态（正文盘面定位，trashEntryId 空）源章存活正文无需
  // 还原；常规形态 restoreTrash（OCCUPIED 等失败透传——目标已回滚，重试直接进本
  // 分支续跑；restoreTrash 自带 R65-36 字节一致幂等续跑）
  if (loc.trashEntryId !== '') {
    const restored = await restoreTrash(bookRoot, loc.trashEntryId)
    if (!restored.ok) {
      return fail(restored.code, `目标章已回滚（并入 已摘），但源章还原失败：${restored.reason}——重试将自动续跑收尾`)
    }
  }
  // ③ 事件 + ④ RAG 指纹失效（目标章内容已变；源章下轮 buildIndex 按 missingFingerprint
  // 重嵌）+ ⑤ 缓存失效
  const undoData: StructureMergeUndoData = {
    op: 'merge-undo',
    targetDocId,
    sourceDocId: loc.sourceDocId,
    sourceChapterNo: loc.sourceChapterNo,
    trashEntryId: loc.trashEntryId,
    ...(rollbackId !== undefined ? { rollbackSnapshotId: rollbackId } : {}),
    planHash: loc.planHash,
  }
  await recordStructureEvents(userDataPath, bookRoot, [structureMergeUndoEvent(undoData)])
  rag.cleanupRagAfterMerge(bookRoot, [], t.章号)
  invalidateTreeIndex(bookRoot, true)
  return {
    ok: true,
    targetDocId,
    sourceDocId: loc.sourceDocId,
    sourceChapterNo: loc.sourceChapterNo,
    trashEntryId: loc.trashEntryId,
    planHash: loc.planHash,
  }
}

// ── 拆分：干跑 + 执行 ────────────────────────────────────────────────

export async function planChapterSplit(
  bookRoot: string,
  svc: DocumentService,
  docId: string,
  cursorOffset: number,
): Promise<SplitPlanView | StructureFailure> {
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
  // ③ 事件 + ④ RAG 指纹失效（原章内容已变，下轮 buildIndex 重嵌两章）+ ⑤ 缓存失效
  await recordStructureEvents(userDataPath, bookRoot, [
    structureSplitEvent({
      op: 'split',
      docId: input.docId,
      newDocId: created.docId,
      originChapterNo: o.章号,
      newChapterNo,
      order,
      title,
    }),
  ])
  rag.cleanupRagAfterMerge(bookRoot, [], o.章号)
  invalidateTreeIndex(bookRoot, true)
  return { ok: true, docId: input.docId, newDocId: created.docId, originChapterNo: o.章号, newChapterNo, order, title }
}

// ── S5 崩溃不变量判定（detectState 书内检查挂点，设计方案 §5.5）─────────

/** 结构半成态条目（healthCheck 报文素材；只读判定零副作用）。 */
export interface StructureViolation {
  /** 目标章清单 id（无布线/未登记书形态回落 null，报文用 path 定位） */
  targetDocId: string | null
  targetPath: string
  targetChapterNo: number
  targetTitle: string
  sourceChapterNo: number
}

/**
 * 崩溃不变量（repair 判定式）：`并入` 所指章**不得存活于正文**。扫描正文区各章 fm
 * `并入` 登记 × 正文章号全集，所指章号有存活文件即合并半成态（① 后崩溃：fm 已写、
 * 源章软删未起，内容暂重复可见）——收敛路径 = 重跑 apply 幂等续跑（finishMerge 补完
 * 收尾段）或 merge-undo 整体回退（正文盘面定位 + 还原段跳过），两形态见
 * applyChapterMerge / undoChapterMerge 的崩溃分支。正常完成态（源章在回收站/已撤销）
 * 与链式折叠多源态（仅最新源存活判 violation，历史源已在回收站）零误报。
 */
export function detectStructureViolations(bookRoot: string): StructureViolation[] {
  const bodyDir = join(bookRoot, BODY_PREFIX)
  const violations: StructureViolation[] = []
  if (!existsSync(bodyDir)) return violations
  const nos = new Set<number>()
  const registered: { no: number; title: string; path: string; mergedInto: number[] }[] = []
  walkMdEach(bodyDir, (fp, name) => {
    const n = chapterNoFromName(name)
    if (n === null) return
    nos.add(n)
    const raw = readMdTextCached(fp)
    const sp = raw === null ? null : splitFrontMatter(raw)
    if (!sp) return
    const fm = parseFlat(sp.fmRaw)
    const mergedInto = parseMergedInto(fm.get('并入')) ?? []
    if (mergedInto.length === 0) return
    const title = fm.get('标题')
    registered.push({
      no: n,
      title: typeof title === 'string' ? title : '',
      path: relative(bookRoot, fp).replaceAll('\\', '/'),
      mergedInto,
    })
  })
  for (const r of registered) {
    for (const src of r.mergedInto) {
      if (nos.has(src)) {
        violations.push({
          targetDocId: null,
          targetPath: r.path,
          targetChapterNo: r.no,
          targetTitle: r.title,
          sourceChapterNo: src,
        })
      }
    }
  }
  // 报文确定性：按目标章号 → 源章号排序（walkMdEach 的 readdir 序随文件系统波动）
  violations.sort((a, b) => a.targetChapterNo - b.targetChapterNo || a.sourceChapterNo - b.sourceChapterNo)
  return violations
}
