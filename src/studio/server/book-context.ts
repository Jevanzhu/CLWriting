/**
 * 书级上下文读取（P1-8 架构下沉：readKind 已下沉 src/format/kind.ts）。
 * 本文件保留为兼容层，re-export 内核实现，既有 import 方零感知。
 *
 * resolveBook：解析书 entry → bookRoot（health / files / documents 及各 docId 线端点共用，
 * 消除「workDir 判空 + readBooks().find + 404」复制粘贴）。
 * resolveDocEntry：docId → 文档清单条目（check / review / rewrite / analysis 等直读线共用，
 * 消除 readManifest(join(...,'文档清单.jsonl')).entries.get(docId) 样板）。
 */
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readBooks, type BookEntry } from '../../install/books.js'
import { readManifest, type ManifestEntry } from '../../document/manifest.js'
import { safeManifestPath } from '../../fs/safe-path.js'
import { readDraft } from '../../format/draft.js'
import { replyError } from './http.js'

export { readKind } from '../../format/kind.js'

/** 解析书：找 entry → bookRoot；workDir 缺 / 书不存在 → error 联合。
 *  hh §八-12：error 分支带机器码（调用方直送 replyError，信封统一 {code,error}）。
 *  R0915-P3-5（四轮处置批）：成功臂携带 workDir——resolveBook 对 null workDir 恒
 *  error，成功即证明 workDir 非 null；此前调用点（rag.ts 三处）只能 `ctx.workDir!`
 *  裸断言表达该不变量，现随成功臂类型可证（加性字段，既有解构消费零影响）。 */
export function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string; entry: BookEntry; workDir: string } | { error: string; status: number; code: string } {
  if (!workDir) return { error: '未定位到工作目录', status: 400, code: 'NO_WORKDIR' }
  if (!name) return { error: '缺少书名', status: 400, code: 'BAD_INPUT' }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404, code: 'NOT_FOUND' }
  return { bookRoot: join(workDir, entry.path), entry, workDir }
}

/** resolveBook 双行样板单源（SRV-N8·专项精简优化 §五，2026-09-15 机械批收编路由入口
 *  72 处「resolveBook + error 分支 replyError」两行样板）。失败时已回写错误响应
 *  （code/error 信封与原样板逐字节同源——直送 replyError），返回 null 供调用方
 *  early-return；成功返回原联合成功臂（bookRoot + entry，三处 r.entry 消费点保持）。 */
export function resolveBookOrReply(
  workDir: string | null,
  name: string | undefined,
  res: ServerResponse,
): { bookRoot: string; entry: BookEntry; workDir: string } | null {
  const r = resolveBook(workDir, name)
  if ('error' in r) {
    replyError(res, r.status, r.code, r.error)
    return null
  }
  return r
}

/** docId → 文档清单条目；未登记 / 清单缺失 → null（调用方按 NOT_FOUND 语义回复）。 */
export function resolveDocEntry(bookRoot: string, docId: string): ManifestEntry | null {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId) ?? null
}

// ── R0912-B-P3-2（2026-09-12 第十篇独立重评修复批）：书注册重验单源 ─────────────
// documents / style / knowledge / config 四个写端点族各持一份同构 bookMovedFailure
// 本地拷贝（R1010b-SRV-P2-1 / R0911-B-P3-4 分头落地），判定口径与人话文案面临漂移
//（documents 版多一个 ok:false 形状）。收敛到本文件（与 resolveBook 同址，四消费方
// ctx 均含 workDir），四处头注的时序说明合并如下（先例 revision-guard.ts X-25 样板）：
//
// 【为什么需要重验】handler 入口 resolveBook 捕获的 bookRoot 只是请求入口快照——
// 随后的 await readJson / 伏笔链排队 / 批量落盘的周期让出可跨过 books.ts 删书
//（rmSync 入墓地）/改名（renameSync 搬目录）的 drain 时点（drain 是快照式，快照后
// 新进单元不被 drain 等待），单元体真正执行时书目录已被搬走/删除，后续写盘
//（svc.save / atomicWriteFile / addEntry / commitSamples 等）会对旧捕获路径 mkdir
// recursive 重建目录树成孤儿文件（无 book.yaml，repairBooks 不认领）。
// 【防线形态】写盘临界段首行（或每次让出后）重验 name→bookRoot 注册：只有执行时刻
// 的注册态才贴近真实落盘时刻。已删（解析失败）或 bookRoot 变化（改名/搬目录）→
// 409 BOOK_MOVED；注册未变 → null 放行。重验只判 book 级注册，不动 docId/docPath
// 语义；文档 rename/move 操作本身不改书注册，不受影响。
// 【信封口径】409 经 replyError 单一出口，code='BOOK_MOVED'，reason 人话各端点一致；
// documents.ts 链单元返回联合以 ok 判别，调用点以「核心对象 + ok:false」组合保持
// 其响应契约逐字节不变。

/** 书注册重验：已删（解析失败）或 bookRoot 变化（改名/搬目录）→ 409 结构化失败；
 *  注册未变 → null（放行写盘）。竞态时序与防线形态见上方 R0912-B-P3-2 头注。 */
export function bookMovedFailure(
  workDir: string | null,
  name: string | undefined,
  capturedRoot: string,
): { code: 'BOOK_MOVED'; reason: string } | null {
  const rNow = resolveBook(workDir, name)
  if ('error' in rNow || rNow.bookRoot !== capturedRoot) {
    return { code: 'BOOK_MOVED', reason: '书已改名或已删除，本次操作已取消——请重新打开本书后再试' }
  }
  // 七轮重评-2（2026-09-19 源码独立重评七轮修复批）：注册未变但盘上书目录已不在——
  // 删书/改名端点「renameWithRetry/rmSync 搬盘先行、books.jsonl 登记改写隔多个 await
  // （清史/事件库迁移/books 锁 RMW）」的陈旧注册窗内，上方注册比对被旧条目骗过（窗口
  // 时序见 books-rename.ts 搬盘→清史→迁移→锁内改登记序列）。盘面校验兜底 fail-closed：
  // 注册存在 ⟹ 书目录应存在（建书/改名均先落盘后登记），目录缺失只可能是窗口期
  // 或盘面外力删除——两者都不得对旧路径 mkdir recursive 重建孤儿目录树（正是 R0912-B-P3-2
  // 头注要挡的落地面），人话文案与注册比对分支同文（reason 人话各端点一致的单一不变量）。
  // H501（七轮修复复核批）：盘面判定改 statSync **ENOENT-only**（install/books-repair.ts
  // isDirConfirmedMissing R35-28/P3-13 同口径）——existsSync 对 EACCES/EIO 等一切 stat
  // 错误都返 false，网络盘离线/杀软/同步盘瞬时不可读会把「书还在」误判成已删，22 个
  // 写端点齐误 409；仅 ENOENT（真不存在）才判 BOOK_MOVED，瞬态错误放行走后续真实写
  // 路径由具体操作如实报错。
  let rootMissing = false
  try {
    statSync(capturedRoot)
  } catch (e) {
    rootMissing = (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
  if (rootMissing) {
    return { code: 'BOOK_MOVED', reason: '书已改名或已删除，本次操作已取消——请重新打开本书后再试' }
  }
  return null
}

// ── D2（复审-0914-优化修复批）：docId → 正文解析链收编 ─────────────────────
// 「resolveDocEntry → safeManifestPath → existsSync → readDraft(+TOCTOU 500 守卫)」
// 及错误文案此前在 docId 直读线端点各持一份（analysis ×3 / review ×2 / check ×2 /
// rewrite ×1）。本节收编三档单源（按各端点实际读面拆档，响应字节逐位不变）：
// - resolveDraftByDocId：全链（含单次读取 + TOCTOU 守卫 + 章稿解析）——analysis 三
//   端点用；R66-26/R48-76/R63-7「单次读取取快照」口径随之单源（content 进 readDraft
//   两参形态，一读同源）。
// - resolveDocFile：只走到存在性（不读稿不解析）——check ×2（机检由
//   runCheckForDocument 自读，且机检对象含非章稿文档，章稿解析会误伤）与 rewrite
//  （其读稿无 TOCTOU 守卫为既有语义，守卫化会改失败字节，红线不越）用。
// - readDraftTextGuarded：裸读 + TOCTOU 500 守卫单源——review 两处（:145 主审单读
//   需 buffer、verdict :324 兜底 sourceHash）用；文案单源常量见下。
// 历史文案 variant（字节红线，逐字保留）：BAD_PATH『文档路径不合法』（analysis 族）/
// 『文档路径非法』（review/check/rewrite）；NOT_FOUND 缺省 `文档不存在：${路径}`，
// check-false-positive 传『文档不存在』。

/** D2：TOCTOU 读稿失败人话文案单源（原 analysis.ts:470/551/633、review.ts:145/324 逐字同文）。 */
export const DRAFT_UNREADABLE_TEXT = '读不到正文文件（可能已被移动或删除），请刷新后再试'

/** D2：解析失败结构（status/code/message 直连 replyError 三参；message 已是人话）。 */
export type DocResolveFailure = { ok: false; status: number; code: string; message: string }

/** resolveDocFile 成功形状：清单条目 + 绝对安全路径（调用方再自行读稿/传机检）。 */
export type DocFileResolution =
  | { ok: true; entry: ManifestEntry; absPath: string }
  | DocResolveFailure

/**
 * D2：docId → 清单条目 → 安全路径 → 存在性（不读稿）。失败档文案见上节头注；
 * opts.badPathText 缺省『文档路径不合法』（analysis 族口径），review/check/rewrite
 * 传『文档路径非法』；opts.missingText 缺省 `文档不存在：${路径}`。
 */
export function resolveDocFile(
  bookRoot: string,
  docId: string,
  opts?: { badPathText?: string; missingText?: string },
): DocFileResolution {
  const m = resolveDocEntry(bookRoot, docId)
  if (!m) return { ok: false, status: 404, code: 'NOT_FOUND', message: `文档ID未登记：${docId}` }
  const absPath = safeManifestPath(bookRoot, m.path)
  if (!absPath) return { ok: false, status: 400, code: 'BAD_PATH', message: opts?.badPathText ?? '文档路径不合法' }
  if (!existsSync(absPath)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: opts?.missingText ?? `文档不存在：${m.path}` }
  }
  return { ok: true, entry: m, absPath }
}

/** resolveDraftByDocId 成功形状：单次读取的正文快照（utf-8）+ 同源章稿解析 + 条目/路径。 */
export type DraftResolution =
  | {
      ok: true
      entry: ManifestEntry
      absPath: string
      /** 正文原文字节快照（draftText 同源；sourceHashOf 进 prompt 溯源用）。 */
      content: string
      /** 章稿解析（ok 收窄；NOT_CHAPTER 已在失败档），analyze 系吃 body/chapter。 */
      draft: Extract<ReturnType<typeof readDraft>, { ok: true }>
    }
  | DocResolveFailure

/**
 * D2：docId → 正文解析链全链单源（清单 → 安全路径 → 存在性 → 单次读取（TOCTOU
 * 500 守卫）→ 章稿解析）。R66-26（analyze）/ R48-76（autotag/infer-meta）当年各自
 * 落地的「existsSync 后 µs 级竞态删除不再裸穿 dispatch」守卫随链单源——读失败落
 * 500 IO_ERROR DRAFT_UNREADABLE_TEXT（原文案逐字）。NOT_CHAPTER（非章稿/解析失败）
 * → 400 NOT_CHAPTER + readDraft reason（原口径）。文案 variant 见 resolveDocFile。
 */
export function resolveDraftByDocId(
  bookRoot: string,
  docId: string,
  opts?: { badPathText?: string; missingText?: string },
): DraftResolution {
  const f = resolveDocFile(bookRoot, docId, opts)
  if (!f.ok) return f
  let buf: Buffer
  try {
    buf = readFileSync(f.absPath)
  } catch {
    return { ok: false, status: 500, code: 'IO_ERROR', message: DRAFT_UNREADABLE_TEXT }
  }
  const content = buf.toString('utf-8')
  const draft = readDraft(f.absPath, content)
  if (!draft.ok) return { ok: false, status: 400, code: 'NOT_CHAPTER', message: draft.reason }
  return { ok: true, entry: f.entry, absPath: f.absPath, content, draft }
}

/** readDraftTextGuarded 成功形状：字节 buffer + utf-8 文本同源（review 主审 hash 用 buffer）。 */
export type GuardedRead =
  | { ok: true; buf: Buffer; text: string }
  | DocResolveFailure

/**
 * D2：裸读文件 + TOCTOU 500 守卫单源（review :145 主审单读 / verdict :324 兜底
 * sourceHash；readFileSync(fp,'utf-8') 与 buf.toString('utf-8') 解码逐位一致）。
 * 文案单源 DRAFT_UNREADABLE_TEXT。
 */
export function readDraftTextGuarded(absPath: string): GuardedRead {
  let buf: Buffer
  try {
    buf = readFileSync(absPath)
  } catch {
    return { ok: false, status: 500, code: 'IO_ERROR', message: DRAFT_UNREADABLE_TEXT }
  }
  return { ok: true, buf, text: buf.toString('utf-8') }
}
