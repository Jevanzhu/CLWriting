/**
 * 0918三轮修复批（B201）回归：拆分取号临界区的**跨进程**锁。
 *
 * 修复前 applyChapterSplit 只有进程内互斥（B001 per-bookRoot 串行链）——双进程
 * （GUI 服务 + CLI 合法并存形态）并发拆分同书时，两进程各自扫盘取得同一章号、
 * 新章文件名含标题 → 路径不同 → createDocument 独占探测不拦 → 静默重号。修复后
 * 临界区外层先取 per-bookRoot 跨进程锁（工作区/.structure-op.lock）：
 * - 他进程持锁（本测试手动预持锁模拟，锁文件带本进程活 pid → 判 held 不误接管）：
 *   等满 10s 超时 → OCCUPIED fail-loud（structStatus 已映射 409，零新增码）；
 * - 锁在成功与失败（PLAN_STALE）两态收尾均释放（try/finally），盘上不残留锁文件。
 *
 * 直调模块函数（同 split-apply-numbering-mutex 基线）；OCCUPIED 等待窗用假时钟推进
 * （等待期唯一活动是锁轮询的 setTimeout，显式 toFake Date 保证超时截止判定随假钟走；
 * 判 stale 的 fs 读全同步，可安全虚拟化）。锚：0918三轮修复批 B201。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { planChapterSplit, applyChapterSplit, type StructureRagPort } from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

const BOOK = '拆分跨进程锁测试书'
let studio: StudioHarness
let userDataPath = ''
const lockPath = () => join(studio.bookRoot, '工作区', '.structure-op.lock')

const { createChapter } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

const ragStub: StructureRagPort = {
  estimateRagChunkCount: () => 0,
  cleanupRagAfterMerge: () => {},
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-split-xlock-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-split-xlock-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 拆分跨进程锁测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 直调形态的拆分 apply 入参组装（干跑取指纹）。 */
async function planDirect(
  docId: string,
  content: string,
  marker: string,
): Promise<{ planHash: string; cursorOffset: number }> {
  const cursorOffset = content.indexOf(marker)
  const plan = await planChapterSplit(
    studio.bookRoot,
    new DocumentService({ bookRoot: studio.bookRoot }),
    docId,
    cursorOffset,
  )
  if (!plan.ok) throw new Error(`干跑失败：${JSON.stringify(plan)}`)
  return { planHash: plan.planHash, cursorOffset }
}

describe('0918三轮修复批 B201: 拆分取号跨进程锁', () => {
  it('他进程持锁（预持锁模拟）→ 等满 10s 超时 OCCUPIED fail-loud；释放后重试成功且锁文件收尾清零', async () => {
    const relA = '写作/正文/第一卷/0020-甲章.md'
    const contentA = chapterContent(20, '甲章', '甲章前半段保留。\n\n甲章后半段迁出标记。')
    const dA = await createChapter(relA, contentA)
    const pA = await planDirect(dA, contentA, '甲章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const input = { docId: dA, title: '甲拆分新章', cursorOffset: pA.cursorOffset, planHash: pA.planHash }

    // 预持锁 = 「另一进程正在拆分」的进程内等价物（活 pid 在位 → judgeStaleLock 判 held，
    // 不触发 stale 接管；12s 推进 < 10min 超龄门槛，不误判超龄）
    const pre = tryAcquireCrossProcessLock(lockPath())
    expect(pre).not.toBeNull()
    try {
      // 推进 12s（> 模块内 10s 等待窗，留余量）：轮询每 20ms 一拍，截止判定随假钟 Date 走
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const pending = applyChapterSplit(studio.bookRoot, svc, null, input, ragStub)
      await vi.advanceTimersByTimeAsync(12_000)
      const r = await pending
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('OCCUPIED')
        expect(r.reason).toContain('跨进程锁')
      }
    } finally {
      vi.useRealTimers()
      pre?.()
    }

    // 释放后同 plan 重试 → 成功（锁内重读基线未变：尚无新章落盘）+ 锁文件不残留
    const retry = await applyChapterSplit(studio.bookRoot, svc, null, input, ragStub)
    expect(retry.ok).toBe(true)
    if (!('newChapterNo' in retry)) throw new Error('unreachable')
    expect(retry.newChapterNo).toBe(21)
    expect(existsSync(lockPath())).toBe(false)
  }, 20_000)

  it('成功与 PLAN_STALE 两态收尾锁文件均清零（try/finally 释放面）', async () => {
    const rel40 = '写作/正文/第一卷/0040-丁章.md'
    const rel41 = '写作/正文/第一卷/0041-戊章.md'
    const content40 = chapterContent(40, '丁章', '丁章前半段保留。\n\n丁章后半段迁出标记。')
    const content41 = chapterContent(41, '戊章', '戊章前半段保留。\n\n戊章后半段迁出标记。')
    const d40 = await createChapter(rel40, content40)
    const d41 = await createChapter(rel41, content41)
    const stalePlan = await planDirect(d40, content40, '丁章后半段迁出标记')
    const freshPlan = await planDirect(d41, content41, '戊章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: studio.bookRoot })

    const fresh = await applyChapterSplit(
      studio.bookRoot,
      svc,
      null,
      { docId: d41, title: '戊拆分新章', cursorOffset: freshPlan.cursorOffset, planHash: freshPlan.planHash },
      ragStub,
    )
    expect(fresh.ok).toBe(true)
    expect(existsSync(lockPath())).toBe(false) // 成功收尾释放

    const stale = await applyChapterSplit(
      studio.bookRoot,
      svc,
      null,
      { docId: d40, title: '丁拆分新章', cursorOffset: stalePlan.cursorOffset, planHash: stalePlan.planHash },
      ragStub,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('PLAN_STALE')
    expect(existsSync(lockPath())).toBe(false) // 失败收尾同样释放（修复面 = try/finally）
  })
})
