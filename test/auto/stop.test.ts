import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doAutoBatch, readBatchProgress, pendingRoot, type ChapterProduction, type StopTrigger } from '../../src/auto/batch.js'

function makeBookWithVolumeOutline(): string {
  const root = mkdtempSync(join(tmpdir(), '停止-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', 'v1.md'), '纲', 'utf-8')
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

function goodProduction(ch: number): ChapterProduction {
  return {
    title: `第${ch}章`, outline: `纲${ch}`,
    body: `---\n章号: ${ch}\n标题: 第${ch}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文${ch}\n`,
    chapter: { 章号: ch, 标题: `第${ch}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
  }
}

test('停止① 预算: 宿主返回 budget trigger → paused.reason=budget', async () => {
  const root = makeBookWithVolumeOutline()
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (chapter >= 2) return { reason: 'budget', detail: '第2章调用触顶（8/8）' }
    return goodProduction(chapter)
  }
  const r = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.paused?.reason).toBe('budget')
  expect(r.progress.paused?.at_chapter).toBe(2)
  expect(r.progress.paused?.detail).toContain('触顶')
  expect(r.progress.next_chapter).toBe(2) // 预算停在触发章，提额后续跑同章
  expect(r.produced).toEqual([1]) // 第1章干净产出，第2章停

  rmSync(root, { recursive: true, force: true })
})

test('停止② 质量: isolate=true → 坏章移到 .isolated/ 不出批次', async () => {
  const root = makeBookWithVolumeOutline()
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (chapter >= 2) return { reason: 'quality', detail: '机检红项自愈上限仍红', isolate: true }
    return goodProduction(chapter)
  }
  const r = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.paused?.reason).toBe('quality')
  expect(r.progress.completed).toEqual([1]) // 坏章不进 completed
  expect(r.progress.isolated).toHaveLength(1)
  expect(r.progress.isolated[0]!.chapter).toBe(2)
  expect(r.progress.isolated[0]!.reason).toBe('quality')

  // .isolated/ 目录存在隔离章
  const isoDir = join(pendingRoot(root), '.isolated')
  expect(existsSync(isoDir)).toBe(true)
  expect(existsSync(join(isoDir, '0002'))).toBe(true)
  // 待审清单（非 .isolated）只有第1章
  const pending = readdirSync(pendingRoot(root)).filter((f) => !f.startsWith('.'))
  expect(pending).toEqual(['0001-第1章'])

  rmSync(root, { recursive: true, force: true })
})

test('停止③ 需人: 高风险章禁降级 → paused.reason=human', async () => {
  const root = makeBookWithVolumeOutline()
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (chapter >= 2) return { reason: 'human', detail: '第2章高风险禁降级，需满审但跑不了' }
    return goodProduction(chapter)
  }
  const r = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.paused?.reason).toBe('human')
  expect(r.progress.paused?.detail).toContain('高风险')
  expect(r.progress.next_chapter).toBe(2) // 需人停在触发章，拍板后续跑同章

  rmSync(root, { recursive: true, force: true })
})

test('停止④ 系统: git MERGE_HEAD → paused.reason=system + 不产章', async () => {
  const root = makeBookWithVolumeOutline()
  // 造一个 MERGE_HEAD（模拟合并冲突状态）
  writeFileSync(join(root, '.git', 'MERGE_HEAD'), 'deadbeef', 'utf-8')

  const r = await doAutoBatch({ bookRoot: root, targetCount: 2, produce: async () => goodProduction(1) })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.paused?.reason).toBe('system')
  expect(r.progress.paused?.at_chapter).toBe(1)
  expect(r.produced).toEqual([]) // 系统异常在第1章前就停，一章都没产出

  rmSync(root, { recursive: true, force: true })
})

test('干净章不受连累: ②隔离后同批已产章保留可审', async () => {
  const root = makeBookWithVolumeOutline()
  // 第1、2章干净产出，第3章质量隔离
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (chapter >= 3) return { reason: 'quality', detail: '红项', isolate: true }
    return goodProduction(chapter)
  }
  const r = await doAutoBatch({ bookRoot: root, targetCount: 5, produce: stop })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 第1、2章干净保留在待审清单
  expect(r.progress.completed).toEqual([1, 2])
  expect(r.produced).toEqual([1, 2])
  // 第3章隔离
  expect(r.progress.isolated[0]!.chapter).toBe(3)
  const pending = readdirSync(pendingRoot(root)).filter((f) => !f.startsWith('.'))
  expect(pending.sort()).toEqual(['0001-第1章', '0002-第2章'])

  rmSync(root, { recursive: true, force: true })
})

test('隔离章游标照推: 隔离后 next_chapter 不回填', async () => {
  const root = makeBookWithVolumeOutline()
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (chapter === 2) return { reason: 'quality', detail: '红', isolate: true }
    if (chapter >= 3) return null // 第3章停
    return goodProduction(chapter)
  }
  const r = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 第1章产、第2章隔离、游标推到3，第3章 null 停
  expect(r.progress.completed).toEqual([1])
  expect(r.progress.isolated[0]!.chapter).toBe(2)
  expect(r.progress.next_chapter).toBe(3) // 隔离章后游标照推

  rmSync(root, { recursive: true, force: true })
})

test('--resume: ②隔离章不重跑（跳过隔离章续写）', async () => {
  const root = makeBookWithVolumeOutline()
  // 第一轮：第2章隔离停
  let phase = 1
  const stop = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | StopTrigger | null> => {
    if (phase === 1 && chapter === 2) return { reason: 'quality', detail: '红', isolate: true }
    if (phase === 1 && chapter >= 3) return null
    return goodProduction(chapter)
  }
  const r1 = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop })
  expect(r1.ok).toBe(true)

  // resume：第2章已隔离（不重跑），从 next_chapter=3 续
  phase = 2
  const r2 = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stop, resume: true })
  expect(r2.ok).toBe(true)
  if (!r2.ok) return
  expect(r2.produced).toEqual([3]) // 只续写第3章
  expect(r2.progress.completed).toEqual([1, 3]) // 第2章隔离不在 completed

  rmSync(root, { recursive: true, force: true })
})
