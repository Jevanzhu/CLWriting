/**
 * 重审-批2-2（2026-09-07 全量代码重审 §四P3/§六批2）：批量连写 abort 分支补发
 * self_heal_batch_progress。
 *
 * 修复背景：orchestrateBatch 的 escalate/failed 两停法均发 self_heal_batch_progress
 * （done=已完成章数, stoppedAt），abort 两分支（章前检查 / runChapter 返回 aborted）只
 * recordPause 不发事件——前端批量进度（workbench 监听该事件）在用户中止时缺终点悬停。
 * 修复后：两 abort 分支对齐补发，事件形状与 escalate/failed 一致（aborted 语义由
 * recordPause('aborted') 与 self_heal_result 承载，不新增状态枚举）。
 * 测试基建对齐 test/studio/self-heal-result-semantics.test.ts（vi.mock checkAiCallBudget + genFn 桩）。
 */
import { test, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { makeDualTrackWorkdir, LONG_BOOK, SHORT_BOOK, tempUserData } from '../../studio/fixtures.js'
import { trackTempDir } from '../../helpers/temp-dir.js'
import { runSelfHeal, abortSelfHeal, type SelfHealOpts } from '../../../src/ai/orchestrate/self-heal.js'
import { prepareMaterials } from '../../../src/process/materials.js'
import { runSpec } from '../../../src/ai/tasks/spec.js'
import { makeFakeDriver } from '../fake-driver.js'
import type { CheckOutcome } from '../../../src/studio/server/api/check.js'
import type { DriverEvent } from '../../../src/driver/index.js'
import type { ChapterMeta } from '../../../src/format/types.js'
import type { saveDraft } from '../../../src/studio/server/api/draft.js'
import { checkAiCallBudget } from '../../../src/ai/calls.js'
import { log } from '../../../src/log/index.js'

vi.mock('../../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ai/calls.js')>()
  return { ...actual, checkAiCallBudget: vi.fn() }
})

// 注入缝：只对 hoisted 指定的那一个绝对路径模拟清理失败（EACCES/EPERM 语义）与
// 读失败（stat 仍成功），其余 rmSync/readFileSync 逐字转发真实实现——生产语义零改动；
// 指向未设时即真实实现
const h = vi.hoisted(() => ({ rmFailPath: null as string | null, readFailPath: null as string | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (h.rmFailPath !== null && String(args[0]) === h.rmFailPath) {
        const e: Error & { code?: string } = new Error('EPERM: operation not permitted')
        e.code = 'EPERM'
        throw e
      }
      return actual.rmSync(...args)
    },
    // stat 成功但读失败（EACCES 语义）→ readSafe 回空串；指向未设时逐字转发
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (h.readFailPath !== null && String(args[0]) === h.readFailPath) {
        const e: Error & { code?: string } = new Error('EACCES: permission denied')
        e.code = 'EACCES'
        throw e
      }
      return actual.readFileSync(...args)
    },
  }
})
vi.mock('../../../src/process/materials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/process/materials.js')>()
  return { ...actual, prepareMaterials: vi.fn() }
})
vi.mock('../../../src/ai/tasks/spec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ai/tasks/spec.js')>()
  return { ...actual, runSpec: vi.fn() }
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

const save: typeof saveDraft = async (_root, _ch, content) => ({
  relPath: '写作/正文/1-测试章.md',
  docId: 'doc-短篇-1',
  words: content.length,
  snapshotted: false,
})

function makeOpts(
  emitted: DriverEvent[],
  genFn: NonNullable<SelfHealOpts['genFn']>,
  check: (p: string) => CheckOutcome,
): SelfHealOpts {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  return {
    driver: makeFakeDriver({ emitted }),
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
  const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as
    { done?: number; total?: number; stoppedAt?: number } | undefined
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
  const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as
    { done?: number; total?: number; stoppedAt?: number } | undefined
  expect(bp).toBeTruthy()
  expect(bp?.done).toBe(1) // 章1 已完成
  expect(bp?.total).toBe(2)
  expect(bp?.stoppedAt).toBe(2) // 停在第 2 章章前
})

/**
 * D1-04 不变量端到端钉：备料失败 + 旧材料清理失败（EPERM）而盘上材料仍在时，
 * 首稿 prompt 照旧注入「备料」段 ⇒ 同一轮 promptFiles 必须登记该材料路径
 * （铁律①「模型可见 ⟺ 已记录」的同真同假）。
 *
 * 断言面 = runSpec 收到的 (userPrompt, promptFiles) 对：注入为真而登记缺失即红。
 * 该不变量由两处共同承载：buildDraftPrompt 读盘成功即把材料路径并入 draft.files
 * （draft-pipeline.ts 的 pushFile），self-heal 再与备料返回清单取并集（self-heal.ts:600）。
 * 清理失败回退分支（self-heal.ts:494 的 statSync 复检并入）在本路径不可独立观测——
 * 短路该分支实测本用例仍绿（材料路径经 draft.files 已登记），故本用例锁的是
 * 「盘上材料存在 ⟺ 已登记」这条不变量本身，非该分支的实现细节。
 */
test('D1-04: 备料失败 + 旧材料清理失败(EPERM) → 材料仍在盘且同轮 promptFiles 已登记', async () => {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '长篇', LONG_BOOK) // 长篇 fixture 带布线/ → ctx.db 非空（备料接线可达）
  const materialPath = join(bookRoot, '工作区', '本章写作材料.md')
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(materialPath, '上一章的旧材料内容', 'utf-8')
  const emitted: DriverEvent[] = []
  const save: typeof saveDraft = async (_root, _ch, content) => ({
    relPath: '写作/正文/0005-第五章.md',
    docId: 'd1-04-5',
    words: content.length,
    snapshotted: false,
  })
  const opts: SelfHealOpts = {
    driver: makeFakeDriver({ emitted }),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 5, // 新章（fixture 章 3/4 带定稿基线，避开覆盖定稿闸）
    check: (): CheckOutcome => ({
      ok: true,
      report: { sections: [] },
      hasRed: false,
      chapter: { 章号: 5, 标题: '第五章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' },
      body: '正文',
    }),
    save,
  }
  vi.mocked(prepareMaterials).mockRejectedValue(new Error('备料整体失败'))
  vi.mocked(runSpec).mockResolvedValue({
    ok: true,
    data: {
      input: undefined,
      text: '---\n章号: 5\n标题: 第五章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。',
      stopReason: 'tool_use',
    },
    ctrl: new AbortController(),
    usage: null,
    runId: 'd1-04',
    model: null,
  } as never)
  h.rmFailPath = materialPath
  try {
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    // 清理失败：旧材料仍在盘上（不被 rmSync 摘掉）
    expect(existsSync(materialPath)).toBe(true)
    const calls = vi
      .mocked(runSpec)
      .mock.calls.filter((c) => (c[1] as { promptFiles?: string[] }).promptFiles !== undefined)
    expect(calls).toHaveLength(1)
    const first = calls[0]![1] as { promptFiles?: string[]; userPrompt: string }
    // 模型可见：首稿 prompt 的「备料」段照旧带上旧材料内容
    expect(first.userPrompt).toContain('上一章的旧材料内容')
    // 已记录：同一轮 promptFiles 必须含该材料路径（缺失即注册面虚报/漏报）
    expect(first.promptFiles).toContain('工作区/本章写作材料.md')
  } finally {
    h.rmFailPath = null
    vi.mocked(prepareMaterials).mockReset()
    vi.mocked(runSpec).mockReset()
  }
})

/**
 * 反向不变量端到端钉：备料失败 + 旧材料清理失败，且材料「stat 存在但读失败」
 * （EACCES 语义，注入缝）时，buildDraftPrompt 读不到材料 ⇒ prompt 无「备料」段，
 * 同一轮 promptFiles 就不得登记该材料路径——登记却模型不可见 = 溯源反向虚报
 * （铁律①「模型可见 ⟺ 已记录」的另一侧）。
 *
 * 判据必须与 buildDraftPrompt 的「备料」段同源（读判据 readSafe）：只看盘上存在会
 * 在本形态下登记一条模型读不到的材料路径。清理失败仍须 log.warn 留痕（不因读不到而免）。
 * 断言面 = runSpec 收到的 (userPrompt, promptFiles) 对：可见为假而登记为真即红。
 */
test('反向: 备料失败 + 清理失败且材料 stat 存在但读失败(EACCES) → 同轮 promptFiles 不登记该路径', async () => {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const materialPath = join(bookRoot, '工作区', '本章写作材料.md')
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(materialPath, '上一章的旧材料内容', 'utf-8')
  const emitted: DriverEvent[] = []
  const save: typeof saveDraft = async (_root, _ch, content) => ({
    relPath: '写作/正文/0005-第五章.md',
    docId: 'read-5',
    words: content.length,
    snapshotted: false,
  })
  const opts: SelfHealOpts = {
    driver: makeFakeDriver({ emitted }),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 5,
    check: (): CheckOutcome => ({
      ok: true,
      report: { sections: [] },
      hasRed: false,
      chapter: { 章号: 5, 标题: '第五章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' },
      body: '正文',
    }),
    save,
  }
  vi.mocked(prepareMaterials).mockRejectedValue(new Error('备料整体失败'))
  vi.mocked(runSpec).mockResolvedValue({
    ok: true,
    data: {
      input: undefined,
      text: '---\n章号: 5\n标题: 第五章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。',
      stopReason: 'tool_use',
    },
    ctrl: new AbortController(),
    usage: null,
    runId: 'd1-04-read',
    model: null,
  } as never)
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  h.rmFailPath = materialPath
  h.readFailPath = materialPath
  try {
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    // 清理失败：旧材料仍在盘上（stat 成功），只是读不到
    expect(existsSync(materialPath)).toBe(true)
    const calls = vi
      .mocked(runSpec)
      .mock.calls.filter((c) => (c[1] as { promptFiles?: string[] }).promptFiles !== undefined)
    expect(calls).toHaveLength(1)
    const first = calls[0]![1] as { promptFiles?: string[]; userPrompt: string }
    // 模型不可见：读失败 = prompt 无「备料」段
    expect(first.userPrompt).not.toContain('上一章的旧材料内容')
    // 已记录面同假：不登记模型读不到的材料路径
    expect(first.promptFiles).not.toContain('工作区/本章写作材料.md')
    // 清理失败仍留痕（读不到材料不免除 warning）
    const warned = warnSpy.mock.calls.some(
      (c) => c[0] === 'self-heal' && typeof c[1] === 'string' && c[1].includes('旧写作材料清理失败'),
    )
    expect(warned).toBe(true)
  } finally {
    warnSpy.mockRestore()
    h.rmFailPath = null
    h.readFailPath = null
    vi.mocked(prepareMaterials).mockReset()
    vi.mocked(runSpec).mockReset()
  }
})
