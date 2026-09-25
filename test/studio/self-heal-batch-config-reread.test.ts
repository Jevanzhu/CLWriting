// 0918二轮修复批（A102）：self-heal 批量连写章边界重读 book config 回归。
// 文件头锚注：源码锚 src/ai/orchestrate/self-heal.ts（orchestrateBatch 章边界 ctx.config
// 重建 + default check 读 ctx.config；批头 applyGlobalDefaults(readBookConfig(...)) 初值）。
//
// 修复前：book.yaml 批头读一次贯穿全批（ChapterCtx.config 冻结）——作者批中改
// budget/字数对本批不生效，与 chat 侧（runner.ts 每次 runTask 重读 book.yaml 的
// 「下次发送即生效」）口径不一。
//
// 修复后：批量循环每章开始时按同一表达式重建 config（readBookConfig 信封语义不变：
// 读失败回落默认 + applyGlobalDefaults 合并），本章预算闸（checkAiCallBudget 收到的
// config 实参）吃到新值。
//
// 改值锚点选 budget.tokens_per_chapter（书级优先键——书级有值一律保留，global 只托底）：
// budget.calls_per_chapter 自 2026-08-19 起为「全局固定」键（applyGlobalDefaults
// 无条件以 global → 硬编码覆盖书级值，书级旧值忽略），改它无法区分「冻结」与「重读」。
// 测试经 vi.mock 捕获预算闸实参（替身模式沿 self-heal-batch-pause.test.ts 先例；
// genFn 替身不走 runTask 记账，真实预算计数与本用例无关，锁的是「闸收到的 config
// 随章边界刷新」这条接线）。
import { test, expect, vi, describe, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'

vi.mock('../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/calls.js')>()
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

function makeSave(): typeof saveDraft {
  return async (_bookRoot, _chapter, content) => ({
    relPath: '写作/正文/1-测试章.md',
    docId: 'doc-短篇-1',
    words: content.length,
    snapshotted: false,
  })
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
    cancelStream(): void {},
    interrupt(): void {},
    isRunning(): boolean { return false },
    isWriterRunning(): boolean { return false },
    registerCtrl(): void {},
    unregisterCtrl(): void {},
  }
}

/** 预算闸实参捕获：[(chapter, tokens_per_chapter), ...]——checkAiCallBudget 恒放行 */
const gateCalls: Array<{ chapter: number; tokens: number | undefined }> = []

const budgetOk = { ok: true, used: 0, limit: 8 } as const

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

beforeEach(() => {
  gateCalls.length = 0
  vi.mocked(checkAiCallBudget).mockReset()
  vi.mocked(checkAiCallBudget).mockImplementation(((
    _root: string,
    chapter: number,
    config: { budget?: { tokens_per_chapter?: number } },
  ) => {
    gateCalls.push({ chapter, tokens: config?.budget?.tokens_per_chapter })
    return budgetOk
  }) as typeof checkAiCallBudget)
})

describe('A102: 批量连写章边界重读 book config', () => {
  test('批中改 book.yaml 的 budget.tokens_per_chapter → 下一章预算闸吃新值（修复前整批冻结批头值）', async () => {
    const workDir = makeDualTrackWorkdir()
    cleanup.push(workDir)
    const bookRoot = join(workDir, '短篇', SHORT_BOOK)
    // 夹具短篇书 budget 段补书级 tokens_per_chapter: 6000（书级优先键，改它可区分冻结/重读）
    const yamlPath = join(bookRoot, 'book.yaml')
    const yaml0 = readFileSync(yamlPath, 'utf8')
    expect(yaml0).toContain('calls_per_chapter: 8')
    writeFileSync(yamlPath, yaml0.replace('budget:\n  calls_per_chapter: 8\n', 'budget:\n  calls_per_chapter: 8\n  tokens_per_chapter: 6000\n'))

    const emitted: DriverEvent[] = []
    let genCount = 0
    // 章 1 生成期间（批中）作者把 budget.tokens_per_chapter 6000 → 3000——章 2 预算闸应见 3000
    const genFn = async (_prompt: string, _kind: 'long' | 'short', _signal: AbortSignal, onText: (d: string) => void) => {
      genCount++
      if (genCount === 1) {
        writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('tokens_per_chapter: 6000', 'tokens_per_chapter: 3000'))
      }
      const t = FM + `第${genCount}章正文`
      if (onText) onText(t)
      return t
    }
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: join(tmpdir(), 'clwriting-test'),
      cwd: workDir,
      bookRoot,
      bookName: BOOK,
      chapter: 1,
      chapters: [1, 2],
      check: () => greenOutcome(),
      save: makeSave(),
      genFn,
    }

    const r = await runSelfHeal(opts)
    // 两章全绿正常收尾（gate 恒放行，行为面不受影响——变化只在闸实参）
    expect(r.outcome).toBe('pass')

    // 预算闸每章首稿各一道：章 1 见批头值 6000；章 2 见批中新值 3000（修复前章 2 仍 6000）
    expect(gateCalls.length).toBe(2)
    expect(gateCalls[0]).toEqual({ chapter: 1, tokens: 6_000 })
    expect(gateCalls[1]).toEqual({ chapter: 2, tokens: 3_000 })
  })
})
