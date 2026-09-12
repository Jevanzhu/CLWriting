/**
 * learn 候选入库 —— 作者审核挑选后的候选写入文风条目库（文风系统重整 S8）。
 *
 * 样章候选 → 样章条目（说明=技法指令）；金句候选 → 样章条目 + 标签[金句]。
 * 来源统一「收割」；序号/目录由 addEntry 统一管理（文风/条目/样章/）。
 *
 * 红线：作者审核才入库（只处理传入的 picks，不自动入库）。
 */

import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { yieldToEventLoop } from '../async.js'
import { addEntry, readEntries, ENTRIES_DIR } from '../format/style-entry.js'
import { log } from '../log/index.js'
import type { SampleCandidate, QuoteCandidate } from './index.js'

// ── R0911-B-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：批量落盘周期让出 ──────────
// learn-commit 单数组上限 400 条（knowledge.ts 重评2-P3-⑤a），逐条 addEntry 各含原子写
// tmp+fsync+rename——慢盘上 400×双 fsync 的同步段可秒级，而本服务进程同时承载 SSE
// 心跳与全部请求，全程无让出即整窗冻结（上限只封顶不消除）。每 COMMIT_YIELD_EVERY
// 条让出一次事件循环（setImmediate 真让出，先例 progress.ts yieldToEventLoop）。
// 让出函数做成可注入参数而非硬编码：服务端调用方在让出点复合书注册重验（knowledge.ts
// B-P3-4），测试注入计数桩断言让出次数/时机——本文件保持领域纯净，不感知 HTTP 层。
// 持久化语义（原子写 + fsync）与返回值形状零变更，只在循环里插入 await 点。
export type CommitYield = () => Promise<void>
// R0912-2 P3（2026-09-12 全量重评修复批）：defaultCommitYield 收敛单源——原内联
// `() => new Promise((resolve) => setImmediate(resolve))` 与 src/async.ts 的
// yieldToEventLoop 同体重复（async.ts 头注宣称「五处收敛单源」，此处漏网）。现直接
// 引用单源，语义逐位一致（同为 setImmediate 落 libuv check 阶段）；导出名保留——
// knowledge.ts 的缺省值/reset fallback 仍按名消费。
export const defaultCommitYield: CommitYield = yieldToEventLoop
/** R0911-B-P3-3：让出粒度——每满 100 条让一次（400 上限即最多 3-4 次让出，单次
 *  同步段回落到百 ms 量级内）。 */
const COMMIT_YIELD_EVERY = 100

/**
 * R27-63（二十七轮）：内容指纹去重——「场景+正文」sha256。双击提交/重放同一批
 * picks 此前会落两份同内容条目（序号递增、注入层重复计权）；同指纹已存在 → 跳过
 * addEntry，返回既有条目的库相对路径（幂等：重放的返回值与首次一致）。指纹含场景，
 * 同金句收进不同场景仍各得一条（场景是注入层的取用键，不算重复）。
 */
function contentFp(kind: '样' | '句', scene: string, body: string): string {
  return createHash('sha256').update(`${kind}\u0000${scene.trim()}\u0000${body.trim()}`, 'utf-8').digest('hex')
}

/** 样章条目库既有指纹集（条目库读失败按空集——去重是尽力而为，不阻断入库） */
function existingSampleFps(bookRoot: string): Map<string, string> {
  const fps = new Map<string, string>()
  try {
    const { entries } = readEntries(`${bookRoot}/${ENTRIES_DIR}`, '样章')
    for (const e of entries) {
      if (e.来源 !== '收割') continue // 只对收割条目去重——作者手建条目内容撞车是合法并存
      // R48-41（四十八轮）：_path 缺失跳过入表并留痕——原入表存空串，下方 `hit !== ''`
      // 把它当未命中，同内容条目绕过去重静默再入库（幂等宣称失效、条目库重复计权且
      // 零留痕）；对齐本函数族 R28-7 去重命中留痕口径
      if (!e._path) {
        log.warn('learn', `样章条目缺 _path，该条指纹未入去重表（同内容再入库不去重）：${e.场景 || e.说明 || '(未知条目)'}`)
        continue
      }
      const kind = Array.isArray(e.标签) && e.标签.includes('金句') ? '句' : '样'
      fps.set(contentFp(kind, e.场景, e.正文), e._path)
    }
  } catch {
    /* 条目库不存在/不可读 → 无既有指纹，全部照常入库 */
  }
  return fps
}

/** 逐 pick 去重入库；返回库相对路径列表（既有条目转 POSIX 相对路径，与 addEntry 同口径）。
 *  describe（R28-7）：被吞条目的可读摘要提取器（技法指令/出处），去重命中时随 warn 留痕。
 *  R0911-B-P3-3：转 async + 每 COMMIT_YIELD_EVERY 条让出一次（见文件头注）；让出函数
 *  抛错 = 调用方中止信号（knowledge.ts 让出点书注册重验失败），原样上抛终止剩余条目。 */
async function commitDeduped<T>(
  bookRoot: string,
  picks: T[],
  fpOf: (pick: T) => string,
  add: (pick: T) => string,
  describe?: (pick: T) => string,
  yieldFn: CommitYield = defaultCommitYield,
): Promise<string[]> {
  const fps = existingSampleFps(bookRoot)
  const out: string[] = []
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i]!
    // R0911-B-P3-3：每满 100 条让出一次——时机在恰处理完第 100/200/... 条之后、
    // 下一条之前（批尾不满一段不让：函数即将返回，让出无意义）；让出抛错 = 调用方
    // 中止信号（knowledge.ts 让出点书注册重验失败），原样上抛终止剩余条目
    if (i > 0 && i % COMMIT_YIELD_EVERY === 0) await yieldFn()
    const fp = fpOf(pick)
    const hit = fps.get(fp)
    if (hit !== undefined && hit !== '') {
      const rel = relative(bookRoot, hit).replace(/\\/g, '/')
      // R28-7（二十八轮）：指纹只含 kind+场景+正文——同批同场景同正文但技法指令不同
      // 的第二条此前静默去重、指令丢失无迹可查。命中去重时 warn 留痕（既有条目路径 +
      // 被吞条目的技法指令摘要，截 60 字防日志膨胀）；幂等返回值与条目数不变。
      log.warn(
        'learn-commit',
        `内容指纹去重命中，本次提交被跳过（既有条目：${rel}；被吞条目技法指令：${(describe?.(pick) ?? '').trim().slice(0, 60) || '（无）'}）`,
      )
      out.push(rel)
      continue
    }
    const rel = add(pick)
    fps.set(fp, `${bookRoot}/${rel}`) // 同批 picks 内也去重（一次提交两份同内容只落一条）
    out.push(rel)
  }
  return out
}

/**
 * 样章候选入库（作者挑选后调用）。
 * R0911-B-P3-3：转 async（周期让出，见文件头注）——持久化语义与返回值形状不变。
 * @returns 入库的文件路径列表（相对书仓库；R27-63 起重复内容返回既有条目路径）
 */
export async function commitSamples(
  bookRoot: string,
  picks: SampleCandidate[],
  yieldFn: CommitYield = defaultCommitYield,
): Promise<string[]> {
  return commitDeduped(
    bookRoot,
    picks,
    (p) => contentFp('样', p.场景, p.正文),
    (p) =>
      addEntry(bookRoot, {
        类型: '样章',
        场景: p.场景,
        来源: '收割',
        ...(p.技法指令 ? { 说明: p.技法指令 } : {}),
        出处: p.出处,
        正文: p.正文,
      }),
    // R28-7：被吞条目的技法指令摘要（空则回退出处，去重 warn 可定位）
    (p) => p.技法指令 || p.出处,
    yieldFn,
  )
}

/**
 * 金句候选入库（样章条目 + 标签[金句]，供注入层按标签取用）。
 * R0911-B-P3-3：转 async（周期让出，见文件头注）——持久化语义与返回值形状不变。
 * @returns 入库的文件路径列表（相对书仓库；R27-63 起重复内容返回既有条目路径）
 */
export async function commitQuotes(
  bookRoot: string,
  picks: QuoteCandidate[],
  yieldFn: CommitYield = defaultCommitYield,
): Promise<string[]> {
  return commitDeduped(
    bookRoot,
    picks,
    (p) => contentFp('句', p.场景, p.正文),
    (p) =>
      addEntry(bookRoot, {
        类型: '样章',
        场景: p.场景,
        来源: '收割',
        标签: ['金句'],
        出处: p.出处,
        正文: p.正文,
      }),
    // R28-7：金句候选无技法指令字段，摘要取出处定位
    (p) => p.出处,
    yieldFn,
  )
}
