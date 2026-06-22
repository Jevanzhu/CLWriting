import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { recordAiCall } from '../../src/ai/calls.js'
import { readMetrics } from '../../src/metrics/ledger.js'
import { REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import { doAutoBatch, pendingRoot, type ChapterProduction } from '../../src/auto/batch.js'
import {
  listPendingChapters,
  finalizePendingChapters,
  rollbackPendingBatch,
  rejectPendingChapter,
} from '../../src/auto/review-batch.js'
import { reviewCommand } from '../../src/cli/review.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建书 + 连写 N 章进待定稿（用 doAutoBatch 桩）。 */
async function makeBookWithPending(n: number): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), '批审-'))
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

  const produce = async ({ chapter }: { chapter: number }): Promise<ChapterProduction> => {
    const meta = chapter === 1
      ? { hook: '情绪钩' as const, level: '弱' as const, emotion: '转折' as const }
      : { hook: '悬念钩' as const, level: '强' as const, emotion: '铺垫' as const }
    return {
      title: `第${chapter}章`, outline: `纲${chapter}`,
      body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: ${meta.hook}\n钩子强弱: ${meta.level}\n情绪定位: ${meta.emotion}\n---\n\n第${chapter}章正文。\n`,
      chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: meta.hook, 钩子强弱: meta.level, 情绪定位: meta.emotion },
    }
  }
  await doAutoBatch({ bookRoot: root, targetCount: n, produce })
  return root
}

async function makeShortBookWithPending(n: number): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), '短篇批审-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })

  const produce = async ({ chapter }: { chapter: number }): Promise<ChapterProduction> => ({
    title: `第${chapter}夜`,
    outline: `纲${chapter}`,
    body: `---\n篇号: ${chapter}\n标题: 第${chapter}夜\n目标情绪: 惊悚\n核心反转: 来客就是死者\n---\n\n第${chapter}夜正文。\n`,
    chapter: { 章号: chapter, 标题: `第${chapter}夜`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' },
  })
  await doAutoBatch({ bookRoot: root, targetCount: n, produce })
  return root
}

/** 给待定稿章写 approved 审稿裁决。 */
function approvePending(bookRoot: string, chapter: number): void {
  const pending = readdirSync(pendingRoot(bookRoot)).filter((f) => !f.startsWith('.') && f.startsWith(String(chapter).padStart(4, '0')))
  const dir = join(pendingRoot(bookRoot), pending[0]!)
  writeFileSync(join(dir, '审稿.md'), `\`\`\`\n${REVIEW_VERDICT_MARKER} verdict: 通过\n\`\`\`\n`, 'utf-8')
  // 待定稿章需有确认记录（前置闸 #3 哈希闸）
  doConfirm(dir, chapter, join(dir, '细纲.md'), 'manual', DEFAULT_CONFIG)
}

function approveShortPending(bookRoot: string, chapter: number): void {
  const pending = readdirSync(pendingRoot(bookRoot)).filter((f) => !f.startsWith('.') && f.startsWith(String(chapter).padStart(3, '0')))
  const dir = join(pendingRoot(bookRoot), pending[0]!)
  writeFileSync(join(dir, '审稿.md'), `\`\`\`\n${REVIEW_VERDICT_MARKER} verdict: 通过\n\`\`\`\n`, 'utf-8')
  doConfirm(dir, chapter, join(dir, '细纲.md'), 'manual', SHORT_CONFIG)
}

test('listPendingChapters: 列待审章 + 识别裁决状态', async () => {
  const root = await makeBookWithPending(2)
  const list = listPendingChapters(root)
  expect(list).toHaveLength(2)
  expect(list[0]!.chapter).toBe(1)
  expect(list[1]!.chapter).toBe(2)
  expect(list[0]!.hasVerdict).toBe(false) // 连写产出无审稿

  rmSync(root, { recursive: true, force: true })
})

test('逐章定稿: approved 章 finalize --from 原子 commit + 删待定稿目录', async () => {
  const root = await makeBookWithPending(2)
  approvePending(root, 1) // 第1章 approved

  const results = finalizePendingChapters(root, [1])
  expect(results[0]!.ok).toBe(true)
  // 定稿区有第1章
  expect(existsSync(join(root, '定稿', '正文', '1-第1章.md'))).toBe(true)
  // git 有 ch:0001
  const log = execSync('git log --oneline', { cwd: root, stdio: 'pipe' }).toString()
  expect(log).toContain('ch:0001')
  // 待定稿第1章目录已删
  const remaining = listPendingChapters(root)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.chapter).toBe(2)
  // 批量定稿必须保留草稿里的章元数据，不得写成默认钩子/情绪
  const finalized = readFileSync(join(root, '定稿', '正文', '1-第1章.md'), 'utf-8')
  expect(finalized).toContain('钩子类型: 情绪钩')
  expect(finalized).toContain('钩子强弱: 弱')
  expect(finalized).toContain('情绪定位: 转折')

  rmSync(root, { recursive: true, force: true })
})

test('短篇逐篇定稿: approved 待定稿篇落 篇/ + pc commit + 清单归档', async () => {
  const root = await makeShortBookWithPending(2)
  const pendingName = readdirSync(pendingRoot(root)).find((f) => !f.startsWith('.') && f.startsWith('001-'))!
  const pendingDir = join(pendingRoot(root), pendingName)
  writeFileSync(join(pendingDir, '清单.md'), '## 反转线索表\n- 核心反转：来客就是死者\n', 'utf-8')
  approveShortPending(root, 1)

  const results = finalizePendingChapters(root, [1])

  expect(results[0]!.ok).toBe(true)
  expect(existsSync(join(root, '篇', '001-第1夜', '正文.md'))).toBe(true)
  expect(existsSync(join(root, '篇', '001-第1夜', '清单.md'))).toBe(true)
  const log = execSync('git log --oneline', { cwd: root, stdio: 'pipe' }).toString()
  expect(log).toContain('pc:001')
  expect(log).not.toContain('ch:0001')
  const remaining = listPendingChapters(root)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.chapter).toBe(2)

  rmSync(root, { recursive: true, force: true })
})

test('短篇 listPendingChapters: 识别 3 位篇号目录与裁决状态', async () => {
  const root = await makeShortBookWithPending(2)
  approveShortPending(root, 2)

  const list = listPendingChapters(root)

  expect(list.map((p) => p.chapter)).toEqual([1, 2])
  expect(list[0]!.title).toBe('第1夜')
  expect(list[0]!.hasVerdict).toBe(false)
  expect(list[1]!.verdict).toBe('approved')

  rmSync(root, { recursive: true, force: true })
})

test('逐章定稿: 待定稿账本推进随 batch finalize 落盘履历', async () => {
  const root = await makeBookWithPending(1)
  const pendingName = readdirSync(pendingRoot(root)).find((f) => !f.startsWith('.') && f.startsWith('0001-'))!
  const pendingDir = join(pendingRoot(root), pendingName)
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-040-神秘信件.md'),
    '---\n编号: 伏笔-040\n标题: 神秘信件\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(join(pendingDir, '账本推进.md'), '- 伏笔-040 埋下：第1章正文\n', 'utf-8')
  writeFileSync(join(pendingDir, '细纲.md'), '---\n章号: 1\n推进: [伏笔-040]\n---\n纲1', 'utf-8')
  approvePending(root, 1)

  const results = finalizePendingChapters(root, [1])

  expect(results[0]!.ok).toBe(true)
  const lead = readFileSync(join(root, '大纲', '伏笔', '伏笔-040-神秘信件.md'), 'utf-8')
  expect(lead).toContain('第001章 埋下：第1章正文')
  const files = execSync('git -c core.quotepath=false show --name-only --format= HEAD', { cwd: root, encoding: 'utf-8' })
  expect(files).toContain('伏笔-040-神秘信件.md')

  rmSync(root, { recursive: true, force: true })
})

test('逐章定稿: 待定稿 .ai-calls.json 经 batch finalize 落入 metrics', async () => {
  const root = await makeBookWithPending(1)
  const pendingName = readdirSync(pendingRoot(root)).find((f) => !f.startsWith('.') && f.startsWith('0001-'))!
  const pendingDir = join(pendingRoot(root), pendingName)
  recordAiCall({ workDir: pendingDir, chapter: 1, config: DEFAULT_CONFIG, step: 'outline', tokens: 1000, at: 't1' })
  recordAiCall({ workDir: pendingDir, chapter: 1, config: DEFAULT_CONFIG, step: 'draft', calls: 2, tokens: 3000, at: 't2' })
  recordAiCall({ workDir: pendingDir, chapter: 1, config: DEFAULT_CONFIG, step: 'review', calls: 3, at: 't3' })
  approvePending(root, 1)

  const results = finalizePendingChapters(root, [1])

  expect(results[0]!.ok).toBe(true)
  const records = readMetrics(root)
  expect(records).toHaveLength(1)
  expect(records[0]!.num).toBe(1)
  expect(records[0]!.calls).toEqual({ outline: 1, draft: 2, review: 3, total: 6, limit: 8 })
  expect(records[0]!.tokens).toBe(4000)

  rmSync(root, { recursive: true, force: true })
})

test('CLI: review batch list/finalize 可达并清理已定稿章', async () => {
  const root = await makeBookWithPending(1)
  approvePending(root, 1)
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    reviewCommand(['batch', 'list', root])
    expect(lines.join('\n')).toContain('第 1 章')
    reviewCommand(['batch', 'finalize', root])
    expect(existsSync(join(root, '定稿', '正文', '1-第1章.md'))).toBe(true)
    expect(listPendingChapters(root)).toHaveLength(0)
  } finally {
    log.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: 短篇 review batch list/finalize 文案按篇输出', async () => {
  const root = await makeShortBookWithPending(1)
  approveShortPending(root, 1)
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    reviewCommand(['batch', 'list', root])
    expect(lines.join('\n')).toContain('待审篇 1 篇')
    expect(lines.join('\n')).toContain('第 1 篇')
    reviewCommand(['batch', 'finalize', root])
    expect(existsSync(join(root, '篇', '001-第1夜', '正文.md'))).toBe(true)
    expect(listPendingChapters(root)).toHaveLength(0)
  } finally {
    log.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: review batch rollback --yes 清理待定稿', async () => {
  const root = await makeBookWithPending(1)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    reviewCommand(['batch', 'rollback', root, '--yes'])
    expect(existsSync(pendingRoot(root))).toBe(false)
  } finally {
    log.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('逐章定稿: 未裁决章被前置闸拦', async () => {
  const root = await makeBookWithPending(1)
  // 不写审稿裁决
  const results = finalizePendingChapters(root, [1])
  expect(results[0]!.ok).toBe(false)
  if (!results[0]!.ok) expect(results[0]!.reason).toContain('拍板')
  // 定稿区无第1章
  expect(existsSync(join(root, '定稿', '正文', '1-第1章.md'))).toBe(false)

  rmSync(root, { recursive: true, force: true })
})

test('整批回滚: 清待定稿不涉 git', async () => {
  const root = await makeBookWithPending(2)
  expect(existsSync(pendingRoot(root))).toBe(true)
  const r = rollbackPendingBatch(root)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.cleared).toBe(2)
  expect(existsSync(pendingRoot(root))).toBe(false)
  // git 历史不变
  const log = execSync('git log --oneline', { cwd: root, stdio: 'pipe' }).toString().trim()
  expect(log.split('\n')).toHaveLength(1)

  rmSync(root, { recursive: true, force: true })
})

test('单章打回: 移到 .isolated/ 留痕', async () => {
  const root = await makeBookWithPending(2)
  const r = rejectPendingChapter(root, 1, '情节不合理')
  expect(r.ok).toBe(true)
  // 第1章移到 .isolated/
  expect(existsSync(join(pendingRoot(root), '.isolated'))).toBe(true)
  // 待审清单只剩第2章
  const remaining = listPendingChapters(root)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.chapter).toBe(2)

  rmSync(root, { recursive: true, force: true })
})

test('单章打回: 移动失败时不在原待审目录残留 rejection 标记', async () => {
  const root = await makeBookWithPending(1)
  const srcName = readdirSync(pendingRoot(root)).find((f) => f.startsWith('0001-'))!
  const conflictDir = join(pendingRoot(root), '.isolated', srcName)
  mkdirSync(conflictDir, { recursive: true })
  writeFileSync(join(conflictDir, '占位.md'), '已有隔离目录，制造 rename 失败。', 'utf-8')

  const r = rejectPendingChapter(root, 1, '情节不合理')

  expect(r.ok).toBe(false)
  expect(existsSync(join(pendingRoot(root), srcName))).toBe(true)
  expect(existsSync(join(pendingRoot(root), srcName, '.rejection.json'))).toBe(false)

  rmSync(root, { recursive: true, force: true })
})
