/**
 * 章节结构操作——合并编排 + 撤销合并（S3：干跑 plan / 执行 apply + finishMerge /
 * undoChapterMerge 三级定位）。
 *
 * R0916-5f（2026-09-16，⑤④产品巨件拆分波2）：自 structure.ts 三缝一体纯移动拆分而来
 * （纯移动——代码与注释原样随迁，零行为变化）。设计口径正本 = structure.ts 头注
 * （《章节结构操作-设计方案-2026-08-30》v3：留洞制/文件本位/崩溃不变量/锁序/
 * external-merge 写入通道）。公共底座（读态派生/plan 指纹/折叠拼接/事件副录）在
 * structure-core.ts，本文件单向依赖之（core←merge，无环）；RAG 触点经 StructureRagPort
 * 端口由组合根注入（G5 依赖反转，零 rag import）。
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ulid } from '../fs/id.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { safeManifestPath } from '../fs/safe-path.js'
import { patchFlatFm } from '../format/frontmatter.js'
// 0918独立重评修复批（B005 尾项）：isMdFileName = 路径章号提取剥 .md 茎单源（本文件
// chapterNoFromEntryPath 小件）
import { chapterNoFromName, isMdFileName } from '../format/filename.js'
import { countWords } from '../format/words.js'
import { readManifestStrict } from './manifest.js'
import { readVersionRaw, listVersions } from './version.js'
// 0918独立重评修复批（B003）：合并续跑判定读改 strict——listTrash（容错版）吞瞬态
// 读失败成空表会把「已软删」误判成「未软删」续跑（R42-7 service.ts 同款口径：
// 容错版只供只读展示面）。locateMergeByDisk（undo 降级定位，只读候选扫描）维持容错版
import { restoreTrash, listTrash, readTrashManifestStrict, type TrashEntry } from './trash.js'
import { isUtf8Bytes, type DocumentService } from './service.js'
import { invalidateTreeIndex } from './tree.js'
import { readChapterUpdatesForChapter, leadEvidenceMatchesBody } from '../check/lead-updates.js'
import { openSessionStoreAsync, bookHash, type SessionStore } from '../events/store.js'
import { structureMergeEvent, structureMergeUndoEvent } from '../events/chain-bridge.js'
// 0918独立重评修复批（B003）：strict 读失败 reason 组装（errMsg 三目单源，log/index.js）
import { errMsg } from '../log/index.js'
import type { StructureMergeData, StructureMergeUndoData } from '../events/types.js'
import {
  fail,
  readChapterState,
  mergePlanHash,
  foldMergedInto,
  concatChapterBody,
  recordStructureEvents,
  newestVersionWithoutSource,
  chapterNoMismatchFailure,
  VERSIONS_DIR_REL,
  type ChapterDiskState,
  type StructureFailure,
  type StructureRagPort,
} from './structure-core.js'

// ── 公共形状 ─────────────────────────────────────────────────────────

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

export type MergeUndoResult =
  | { ok: true; targetDocId: string; sourceDocId: string; sourceChapterNo: number; trashEntryId: string; planHash: string }
  | StructureFailure

// ── 合并：干跑 ───────────────────────────────────────────────────────

export async function planChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  targetDocId: string,
  sourceDocId: string,
  rag: StructureRagPort,
): Promise<MergePlanView | StructureFailure> {
  if (targetDocId === sourceDocId) return fail('BAD_INPUT', '目标章与源章不能是同一章')
  // B004（0918三拍板批）：入口一致性闸——全书 fm ≡ 文件名号失配即拒（含 undo 半完成
  // 态续跑在内的结构操作都带失配盘面执行会放大重号/错定位，先拒后做）
  const gate = chapterNoMismatchFailure(bookRoot)
  if (gate) return gate
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

/** P3（复审-0914-优化修复批）：applyChapterMerge 幂等续跑两形态（①后/②后）的同构
 *  resumed 字面量收敛单源——原两处 12 行内联字面量逐字段相同，差异只在
 *  sourceChapterNo/mergedInto/rollbackSnapshotId 三个实参；产出逐字段一致。 */
function resumedMergeApplyResult(
  input: { targetDocId: string; sourceDocId: string; planHash: string },
  t: { 章号: number; 并入: number[] },
  sourceChapterNo: number,
  mergedInto: number[],
  rollbackSnapshotId: string | undefined,
): Extract<MergeApplyResult, { ok: true }> {
  return {
    ok: true,
    targetDocId: input.targetDocId,
    sourceDocId: input.sourceDocId,
    targetChapterNo: t.章号,
    sourceChapterNo,
    mergedInto,
    trashEntryId: input.sourceDocId,
    ...(rollbackSnapshotId !== undefined ? { rollbackSnapshotId } : {}),
    planHash: input.planHash,
  }
}

export async function applyChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  input: { targetDocId: string; sourceDocId: string; planHash: string },
  rag: StructureRagPort,
): Promise<MergeApplyResult> {
  if (input.targetDocId === input.sourceDocId) return fail('BAD_INPUT', '目标章与源章不能是同一章')
  // B004（0918三拍板批）：入口一致性闸（同 planChapterMerge；apply 尤须——带失配盘面
  // 写 并入 登记会落错误章号）
  const gate = chapterNoMismatchFailure(bookRoot)
  if (gate) return gate
  const t = await readChapterState(svc, bookRoot, input.targetDocId)
  if (!('章号' in t)) return t
  // S5 崩溃形态分流前移（设计方案 §5.5 repair 判定式）：fm `并入` 已含源章号 = ① 已
  // 落定，此后任何中断都是收尾段半途态，重跑 apply 即幂等收敛。②后崩溃形态（源章已
  // 软删、清单条目已摘）readChapterState(源) 必失败，故先查回收站条目再读源章。
  // 0918独立重评修复批（B003）：续跑判定读改 strict——容错版吞瞬态读失败成空表会
  // 把②后崩溃形态误判成「未软删」续跑；strict 读失败映射既有 WRITE_ERROR（未执行
  // 修改，可重试），ENOENT 仍合法空（无回收站不受影响）。
  let trashCandidates: TrashEntry[]
  try {
    trashCandidates = readTrashManifestStrict(bookRoot)
  } catch (e) {
    return fail('WRITE_ERROR', `回收站清单读取失败（未执行修改，可重试）：${errMsg(e)}`)
  }
  const trashEntry = trashCandidates.find((e) => e.id === input.sourceDocId)
  if (trashEntry) {
    // ②后崩溃形态：源章已进回收站（文件在 .trash、清单条目已摘）——章号从条目
    // originalPath 反推，须与 fm 并入 对应；trash 段已落定，finishMerge 内部自查跳过。
    // 0918独立重评修复批（B005 尾项）：章号提取走剥茎单源 chapterNoFromEntryPath
    const no = chapterNoFromEntryPath(trashEntry.originalPath)
    if (no === null || !t.并入.includes(no)) {
      return fail('NOT_MERGE_STATE', `回收站条目与目标章 fm 并入 不对应（章号 ${no ?? '无法解析'}，并入 = ${t.并入.join(',') || '空'}）——疑似人工处置过，请先「撤销合并」或手工核对盘面`)
    }
    const rollbackSnapshotId = newestVersionWithoutSource(bookRoot, input.targetDocId, no) ?? undefined
    const resumed = resumedMergeApplyResult(input, t, no, t.并入, rollbackSnapshotId)
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
    const resumed = resumedMergeApplyResult(input, t, s.章号, mergedInto, rollbackSnapshotId)
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
  // 0918独立重评修复批（B003）：alreadyTrashed 自查读改 strict（同 apply 入口口径）
  // ——容错版吞瞬态读失败成空表会让②后崩溃续跑误判「未软删」而二次软删空转；
  // strict 读失败按 WRITE_ERROR 如实拒收（未执行修改，重试即续）。
  let trashCandidates: TrashEntry[]
  try {
    trashCandidates = readTrashManifestStrict(bookRoot)
  } catch (e) {
    return fail('WRITE_ERROR', `回收站清单读取失败（未执行修改，可重试）：${errMsg(e)}`)
  }
  const trashEntry = trashCandidates.find((e) => e.id === merged.sourceDocId)
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

/** 0918独立重评修复批（B005 尾项）：清单/回收站条目路径 → 章号——剥 .md 茎后走
 *  chapterNoFromName 单源（裸数字名 0012.md 带扩展直判会因尾点失明；本文件
 *  locateMergeByBody / locateMergeByDisk / applyChapterMerge 三处消费点收编）。 */
function chapterNoFromEntryPath(relPath: string): number | null {
  const base = basename(relPath)
  return chapterNoFromName(isMdFileName(base) ? base.slice(0, -3) : base)
}

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
    // 0918四轮修复批（B404）：type 过滤下推 iterateEvents 第三参——原无过滤单趟走完整
    // 书事件流（含全部 step/llm/call 大载荷逐行 JSON.parse，长书 workspace 会话数万行）。
    // 改两趟 structure 族小流：先收全 merge-undo 的 planHash 撤销集，再在 merge 流里择
    // 最近未被撤销者。undo 恒后于其撤销的 merge 落库（append-only），撤销集先行收集与
    // 旧单趟「走到才记」在常规形态（每 merge 至多一 undo、undo 后于 merge、planHash 唯
    // 一）逐位一致；差异仅在「merge→undo→同 planHash 重并」病态形态——旧单趟会把手为
    // 已撤销者的 found 残留值（更早那次同 hash merge）误当可撤销，两趟补全撤销集后拒得
    // 更干净（null 落回 body/disk 定位链），方向安全。
    const undone = new Set<string>()
    for (const ev of store.iterateEvents(bookHash(bookRoot), undefined, 'structure.merge-undo')) {
      const ph = (ev.data as Record<string, unknown>)['planHash']
      if (typeof ph === 'string') undone.add(ph)
    }
    let found: MergeUndoLocator | null = null
    for (const ev of store.iterateEvents(bookHash(bookRoot), undefined, 'structure.merge')) {
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
    return found
  } finally {
    store.close()
  }
}

/** 降级路径（无事件库/无匹配）：回收站按 trashedAt 择最新条目反推源章号 +
 *  rollbackSnapshotId 走版本推演（newestVersionWithoutSource）。失配返回 null 交上层拒。
 *  拍板快断批（2026-09-15，作者指令「按建议顺序开工」取「择最新」档）：同章号多条
 *  回收站条目（删章→同号重建→再合并→再撤销链）按 trashedAt 取最新——原「第一条」
 *  会误认领历史软删旧条目（阶段 24 批 C e2e 实抓：残留 0005/0006 ×2 被误认领、
 *  源章未还原）。trashedAt 同值时维持清单序首条（稳定）。
 *  0918独立重评修复批（B002）：源章号原取 max(并入)——与事件主路径（最近一条未撤销
 *  merge 事件 = 最近一次合并）口径漂移，乱序合并（先并 20 入 10 再并 5 入 10）时
 *  max=20 撤销的是首并非最近并。对齐主路径「择最新」：候选 = 回收站中章号 ∈ 并入
 *  的条目，跨章号按 trashedAt 取最新者反推源章号（同值仍维持清单序首条）。 */
function locateMergeByDisk(bookRoot: string, mergedInto: number[]): MergeUndoLocator | null {
  if (mergedInto.length === 0) return null
  const merged = new Set(mergedInto)
  let best: TrashEntry | null = null
  let bestNo: number | null = null
  for (const e of listTrash(bookRoot)) {
    // 0918独立重评修复批（B005 尾项）：章号提取走剥茎单源 chapterNoFromEntryPath
    const no = chapterNoFromEntryPath(e.originalPath)
    if (no === null || !merged.has(no)) continue
    if (best === null || e.trashedAt > best.trashedAt) {
      best = e
      bestNo = no
    }
  }
  if (best === null || bestNo === null) return null
  return { sourceDocId: best.id, sourceChapterNo: bestNo, trashEntryId: best.id, planHash: '' }
}

/** S5 正文盘面定位（①后崩溃形态专用）：merge 事件（收尾段才记）与回收站条目（② 才
 *  产生）都缺，源章仍存活正文。
 *  0918独立重评修复批（B002 尾项，主审裁定随批修——判定证据链）：
 *  - 失败面判定：原判据 max(并入) 与 B002 同类错选。乱序合并（先并 61 完成再并 59
 *    至①后中断）下 max=61：常规形态正文无 61 号存活文件 → null → NOT_MERGE_STATE
 *    （fail-loud 撤不动）；但正文另有 61 号存活重号章（跨卷重号脏盘面）时会**错选
 *    无辜章静默回滚**——并非纯 fail-loud，故取「修」支。
 *  - 修法不是 trashedAt 择最新：正文盘面无合并时序信号（并入 数组经 foldMergedInto
 *    排序去重，序不携带时序；事件缺失形态下无任何「哪次最近」盘面证据），改用形态
 *    自身签名——崩溃不变量下①后中断的源章是 并入 中**唯一存活正文**的章号。
 *  - 收窄口径：恰一存活 且 回收站无该章号条目（=①后形态签名；条目在档 = 真源已软
 *    删的历史条目或人工放回混合态）→ 即中断合并源；0 存活（非①后形态）与 ≥2 存活
 *    （人工放回等歧义态）→ null 交上层 NOT_MERGE_STATE fail-loud（原实现多存活时
 *    静默取遍历序首个，此为收紧）。定位前置到 locateMergeByDisk 之前（见
 *    undoChapterMerge 注）：disk 在①后形态会被历史源条目抢先错选。
 *  strict 读失败按 null 走 NOT_MERGE_STATE 拒收（定位失败与「不是合并态」对调用方
 *  等价，不上抛炸端点）。 */
function locateMergeByBody(bookRoot: string, mergedInto: number[]): MergeUndoLocator | null {
  if (mergedInto.length === 0) return null
  const merged = new Set(mergedInto)
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return null
  let m: ReturnType<typeof readManifestStrict>
  try {
    m = readManifestStrict(manifestPath)
  } catch {
    return null
  }
  let hit: { id: string; no: number } | null = null
  for (const [id, e] of m.entries) {
    if (e.nodeType !== 'document') continue
    // 0918独立重评修复批（B005 尾项）：章号提取走剥茎单源（裸数字存活章同款盲区）
    const no = chapterNoFromEntryPath(e.path)
    if (no === null || !merged.has(no)) continue
    // 复审-0913-源码 P2-1：清单条目 path 同源收口（越界/非法条目不探测，等同未命中）
    const abs = safeManifestPath(bookRoot, e.path)
    if (abs !== null && existsSync(abs)) {
      if (hit !== null) return null // 多源存活 = 人工放回等歧义态：fail-loud 交作者
      hit = { id, no }
    }
  }
  if (hit === null) return null
  // ①后形态签名补验：回收站已有该章号条目（真源已软删的历史条目 / 人工放回混合态）
  // = 非①后中断，返回 null 交 disk 定位——restoreTrash 对「文件已回原位」形态自带
  // R41-9 簿记自愈，不动其修复通道
  const aliveNo = hit.no
  if (listTrash(bookRoot).some((e) => chapterNoFromEntryPath(e.originalPath) === aliveNo)) return null
  return { sourceDocId: hit.id, sourceChapterNo: hit.no, trashEntryId: '', planHash: '' }
}

/** 0918独立重评二轮修复批（B105）：撤销半完成态定位（并入 已空形态的 undo 续跑）——
 *  单次合并 undo 走到「①目标已回滚（fm 并入 随内容整体消失）+ ②还原源章失败
 *  （OCCUPIED 等）」中间态：目标 fm 无 并入 + 源章仍在回收站。三重核对后才认领
 *  （任何一环对不上 = 不可识别态，维持 NOT_MERGE_STATE fail-closed 交作者）：
 *  1. 事件副录：最近一条未被 merge-undo 撤销的 structure.merge（完整撤销后
 *     merge-undo 事件在档 → null，天然防「已完整撤销后再次 undo」误续跑）；
 *  2. 回收站：条目仍在盘且章号与事件源章号对齐（人工已还原/条目被处置 → null）；
 *  3. 版本指纹：目标盘面字节 == 回滚版本内容（rollbackSnapshotId 缺失走版本推演
 *     兜底）——防「作者手工摘 并入 键但目标仍是合并后内容」形态误续跑（该形态还原
 *     源章会让正文双份）。
 *  与 B002 定位链协同：body/disk 两定位均以 并入 非空为前提（并入 已空进不来），
 *  本定位是并入已空形态的独立入口，不改写它们的择最新语义。 */
async function locateUndoHalfDone(
  userDataPath: string | null,
  bookRoot: string,
  targetDocId: string,
  t: ChapterDiskState,
): Promise<MergeUndoLocator | null> {
  const loc = await locateLatestMergeEvent(userDataPath, bookRoot, targetDocId)
  if (loc === null) return null
  let entries: TrashEntry[]
  try {
    entries = readTrashManifestStrict(bookRoot)
  } catch {
    // strict 读失败（瞬态占用）：不可判 = 不可续跑（B003 口径——fail-closed 不做修改）
    return null
  }
  const entry = entries.find((e) => e.id === loc.trashEntryId)
  if (entry === undefined) return null
  if (chapterNoFromEntryPath(entry.originalPath) !== loc.sourceChapterNo) return null
  const versionsDir = join(bookRoot, VERSIONS_DIR_REL)
  let rollbackId = loc.rollbackSnapshotId
  if (rollbackId === undefined || readVersionRaw(versionsDir, targetDocId, rollbackId) === null) {
    rollbackId = newestVersionWithoutSource(bookRoot, targetDocId, loc.sourceChapterNo) ?? undefined
  }
  if (rollbackId === undefined) return null
  const snap = readVersionRaw(versionsDir, targetDocId, rollbackId)
  if (snap === null) return null
  if (!snap.content.equals(t.bytes)) return null
  return { ...loc, rollbackSnapshotId: rollbackId }
}

/** 0918独立重评二轮修复批（B105）：undo 收尾段（②还原源章 + ③事件 + ④RAG 指纹
 *  失效 + ⑤缓存失效）——常规路径（回滚后）与半完成态续跑（并入 已空、回滚已在前次
 *  完成）共用；rollbackId 为本次撤销实际采用的回滚版本（事件载荷留档）。 */
async function finishUndo(
  bookRoot: string,
  userDataPath: string | null,
  targetDocId: string,
  targetChapterNo: number,
  loc: MergeUndoLocator,
  rollbackId: string | undefined,
  rag: StructureRagPort,
): Promise<MergeUndoResult> {
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
  rag.cleanupRagAfterMerge(bookRoot, [], targetChapterNo)
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

export async function undoChapterMerge(
  bookRoot: string,
  svc: DocumentService,
  userDataPath: string | null,
  targetDocId: string,
  rag: StructureRagPort,
  hints?: MergeUndoHints,
): Promise<MergeUndoResult> {
  // B004（0918三拍板批）：入口一致性闸——undo 恢复路径绕过 planHash 复核（源章号三
  // 来源全是路径派生号、目标章号是 fm 号，两轨失配时定位链互相矛盾），入口先拒
  const gate = chapterNoMismatchFailure(bookRoot)
  if (gate) return gate
  const t = await readChapterState(svc, bookRoot, targetDocId)
  if (!('章号' in t)) return t
  if (t.并入.length === 0) {
    // 0918独立重评二轮修复批（B105）：并入 已空不再直接 fail——单次合并 undo 走到
    // 「目标已回滚、源章还原失败（OCCUPIED 等）」半完成态后，重试从函数头进来此前
    // 必死本门报「已撤销」，收尾段「重试将自动续跑收尾」的承诺不可达（源章滞留回收
    // 站只能手工发现）。先识别半完成态（locateUndoHalfDone 三重核对），命中则跳过
    // 回滚步（目标已是回滚后内容——版本指纹已核对）直接续 restoreTrash 段；识别不出
    // 维持原 NOT_MERGE_STATE 文案。链式合并（回滚版本仍含前次 并入，过得了下方门）
    // 与 B002 定位链（body/disk 均以 并入 非空为前提）语义不受影响。
    const half = await locateUndoHalfDone(userDataPath, bookRoot, targetDocId, t)
    if (half === null) {
      return fail('NOT_MERGE_STATE', '该章 fm 无 并入 登记（不是合并目标或已撤销）')
    }
    return finishUndo(bookRoot, userDataPath, targetDocId, t.章号, half, half.rollbackSnapshotId, rag)
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
  // 0918独立重评修复批（B002 尾项）：①后崩溃形态定位前置——「并入 中恰一存活源且
  // 回收站无该章号条目」即中断合并源。原序（disk 先行）在乱序合并①后形态会被历史
  // 源条目抢先错选（静默回滚到更早基线）；body 定位自带①后签名补验，非①后形态
  // 恒 null 落回 disk，正常完成态/事件主路径行为不变
  if (loc === null) loc = locateMergeByBody(bookRoot, t.并入)
  if (loc === null) loc = locateMergeByDisk(bookRoot, t.并入)
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
  // 0918独立重评二轮修复批（B105）：回滚后若还原失败，目标处于「并入 已空 + 已回滚」
  // 半完成态——重试经并入门内 locateUndoHalfDone 识别续跑（本段不再重复执行）。
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
  // ②③④⑤ 收尾段（B105：提取 finishUndo 与半完成态续跑共用）
  return finishUndo(bookRoot, userDataPath, targetDocId, t.章号, loc, rollbackId, rag)
}
