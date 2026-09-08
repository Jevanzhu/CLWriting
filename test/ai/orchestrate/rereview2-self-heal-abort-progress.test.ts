/**
 * 重审-批2-2（2026-09-07 全量代码重审 §四P3/§六批2）：批量连写 abort 分支补发
 * self_heal_batch_progress。
 *
 * 修复背景：orchestrateBatch 的 escalate/failed 两停法均发 self_heal_batch_progress
 * （done=已完成章数, stoppedAt），abort 两分支（章前检查 / runChapter 返回 aborted）只
 * recordPause 不发事件——前端批量进度（workbench 监听该事件）在用户中止时缺终点悬停。
 * 修复后：两 abort 分支对齐补发，事件形状与 escalate/failed 一致（aborted 语义由
 * recordPause('aborted') 与 self_heal_result 承载，不新增状态枚举）。
 * 测试基建对齐 test/studio/self-heal-f2.test.ts（vi.mock checkAiCallBudget + genFn 桩）。
 */
import { test, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { makeDualTrackWorkdir, SHORT_BOOK, tempUserData } from '../../studio/fixtures.js'
import { trackTempDir } from '../../helpers/temp-dir.js'
import { runSelfHeal, abortSelfHeal, type SelfHealOpts } from '../../../src/ai/orchestrate/self-heal.js'
import type { CheckOutcome } from '../../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../../src/driver/index.js'
import type { ChapterMeta } from '../../../src/format/types.js'
import type { saveDraft } from '../../../src/studio/server/api/draft.js'
import { checkAiCallBudget } from '../../../src/ai/calls.js'

vi.mock('../../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ai/calls.js')>()
  return { ...actual, checkAiCallBudget: vi.fn() }
})

const BOOK = SHORT_BOOK
const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}
const FM = '---\n章号: 1\n标题: 测试章\n---\n'

function greenOutcome(): CheckOutcome {
  return { ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' }
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

const save: typeof saveDraft = async (_root, _ch, content) => ({
  relPath: '写作/正文/1-测试章.md',
  docId: 'doc-短篇-1',
  words: content.length,
  snapshotted: false,
})

function makeOpts(emitted: DriverEvent[], genFn: NonNullable<SelfHealOpts['genFn']>, check: (p: string) => CheckOutcome): SelfHealOpts {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  return {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
    cwd: workDir,
    bookRoot,
    bookName: BOOK,
    chapter: 1,
    chapters: [1, 2],
    check,
    save,
    genFn,
  }
}

const budgetOk = { ok: true, used: 0, limit: 8 } as const

beforeEach(() => {
  vi.mocked(checkAiCallBudget).mockReset()
  vi.mocked(checkAiCallBudget).mockReturnValue(budgetOk)
})

test('章1 生成中 abort（runChapter 返回 aborted）→ 发 batch_progress 终点（done=0, stoppedAt=1）', async () => {
  const emitted: DriverEvent[] = []
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (_prompt, _kind, _signal, onText) => {
    // 章1 首稿生成途中用户中止（abort 编排在途 ctrl）
    abortSelfHeal(BOOK)
    onText?.(FM + '一章')
    return FM + '一章'
  }
  const opts = makeOpts(emitted, genFn, () => greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('aborted')
  // 修复前：abort 分支只 recordPause 不发事件，前端批量进度缺终点
  const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as { done?: number; total?: number; stoppedAt?: number } | undefined
  expect(bp).toBeTruthy()
  expect(bp?.done).toBe(0) // 已完成 0 章
  expect(bp?.total).toBe(2)
  expect(bp?.stoppedAt).toBe(1) // 停在第 1 章
})

test('章1 完成、章2 开跑前 abort（章前检查分支）→ 发 batch_progress 终点（done=1, stoppedAt=2）', async () => {
  const emitted: DriverEvent[] = []
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (_prompt, _kind, _signal, onText) => {
    onText?.(FM + '正文')
    return FM + '正文'
  }
  // 章1 机检时（其首稿已生成、runChapter 尚未返回 pass）触发中止：章1 照常 pass 收口，
  // 章2 在 orchestrateBatch 循环顶的章前 aborted 检查处停（覆盖另一 abort 分支）
  let checked = 0
  const check = (): CheckOutcome => {
    checked++
    if (checked === 1) abortSelfHeal(BOOK)
    return greenOutcome()
  }
  const opts = makeOpts(emitted, genFn, check)
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('aborted')
  const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as { done?: number; total?: number; stoppedAt?: number } | undefined
  expect(bp).toBeTruthy()
  expect(bp?.done).toBe(1) // 章1 已完成
  expect(bp?.total).toBe(2)
  expect(bp?.stoppedAt).toBe(2) // 停在第 2 章章前
})
