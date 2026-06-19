import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import { enter } from '../../src/state/state.js'
import { doAutoBatch, pendingRoot, type ChapterProduction } from '../../src/auto/batch.js'
import { listPendingChapters, finalizePendingChapters } from '../../src/auto/review-batch.js'

/**
 * M6 端到端出口（工单第 10 节）：连写一批 → enter 落态 8 → 批量审稿 → 逐章定稿 → enter 落态 7。
 * AI 步用桩 produce（编排逻辑全验证，真模型产出由宿主填）。
 */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'm6e2e-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', 'v1.md'), '纲', 'utf-8')
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

test('M6 端到端: 连写→态8→逐章定稿→态7', async () => {
  const root = makeBook()
  const produce = async ({ chapter }: { chapter: number }): Promise<ChapterProduction> => ({
    title: `第${chapter}章`, outline: `纲${chapter}`,
    body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${chapter}章正文。\n`,
    chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
  })

  // 1. 连写 2 章
  const batch = await doAutoBatch({ bookRoot: root, targetCount: 2, produce })
  expect(batch.ok).toBe(true)
  if (!batch.ok) return
  expect(batch.produced).toEqual([1, 2])

  // 2. enter 应落态 8（待批量审稿），不落态 7
  let e = enter(root)
  expect(e.route.state).toBe(8)
  expect(e.route.action).toBe('pending-batch-review')

  // 3. 批量审稿：列待审 + 逐章裁决 approved
  const list = listPendingChapters(root)
  expect(list).toHaveLength(2)
  for (const ch of list) {
    writeFileSync(join(ch.dir, '审稿.md'), `\`\`\`\n${REVIEW_VERDICT_MARKER} verdict: 通过\n\`\`\`\n`, 'utf-8')
    doConfirm(ch.dir, ch.chapter, join(ch.dir, '细纲.md'), 'manual', DEFAULT_CONFIG)
  }

  // 4. 逐章定稿
  const results = finalizePendingChapters(root, [1, 2])
  expect(results.every((r) => r.ok)).toBe(true)
  // 定稿区有两章
  expect(existsSync(join(root, '定稿', '正文', '1-第1章.md'))).toBe(true)
  expect(existsSync(join(root, '定稿', '正文', '2-第2章.md'))).toBe(true)

  // 5. 待定稿已清空 → enter 落态 7（起草新章）
  e = enter(root)
  expect(e.route.state).toBe(7)

  rmSync(root, { recursive: true, force: true })
})

test('M6 端到端: 连写暂停 → resume 续完 → 态8', async () => {
  const root = makeBook()
  const produce = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | null> => {
    if (chapter >= 2) return null // 第2章暂停（需人）
    return {
      title: `第${chapter}章`, outline: `纲${chapter}`,
      body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n`,
      chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
    }
  }

  // 第一轮：第1章产、第2章停
  const r1 = await doAutoBatch({ bookRoot: root, targetCount: 2, produce })
  expect(r1.ok).toBe(true)
  if (!r1.ok) return
  expect(r1.progress.paused?.at_chapter).toBe(2)

  // resume：续写第2章（换全产出桩）
  const full = async ({ chapter }: { chapter: number }): Promise<ChapterProduction> => ({
    title: `第${chapter}章`, outline: `纲${chapter}`,
    body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n`,
    chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
  })
  const r2 = await doAutoBatch({ bookRoot: root, targetCount: 2, produce: full, resume: true })
  expect(r2.ok).toBe(true)
  if (!r2.ok) return
  expect(r2.progress.completed).toEqual([1, 2]) // 进度继承 + 续写第2章

  // enter 落态 8
  const e = enter(root)
  expect(e.route.state).toBe(8)

  rmSync(root, { recursive: true, force: true })
})
