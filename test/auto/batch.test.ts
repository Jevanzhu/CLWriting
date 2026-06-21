import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import {
  doAutoBatch,
  readBatchProgress,
  moveToPending,
  pendingChapterDirName,
  clearPendingBatch,
  pendingRoot,
  writeBatchProgress,
  type ChapterProduction,
} from '../../src/auto/batch.js'

/** 建一本干净书（git init + book.yaml + 卷纲非空 + 初始 commit）。 */
function makeBookWithVolumeOutline(): string {
  const root = mkdtempSync(join(tmpdir(), '连写-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', '第一卷.md'), '# 第一卷纲', 'utf-8')
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 造一个产出回调（桩：按章号产出固定标题+细纲+正文）。 */
function makeProduceStub() {
  return async ({ chapter }: { chapter: number }): Promise<ChapterProduction> => ({
    title: `第${chapter}章`,
    outline: `第${chapter}章细纲`,
    body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${chapter}章正文。\n`,
    chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
  })
}

test('连写: 批次进度正确（章号自管，不重复）', async () => {
  const root = makeBookWithVolumeOutline()
  const r = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: makeProduceStub() })

  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.produced).toEqual([1, 2, 3])
  expect(r.progress.completed).toEqual([1, 2, 3])
  expect(r.progress.next_chapter).toBe(4) // 游标推到第4章
  expect(r.progress.start_chapter).toBe(1)

  rmSync(root, { recursive: true, force: true })
})

test('连写: 产出搬入 待定稿/<章号-标题>/，工作区根清空', async () => {
  const root = makeBookWithVolumeOutline()
  await doAutoBatch({ bookRoot: root, targetCount: 2, produce: makeProduceStub() })

  // 待定稿有两个章目录
  const pending = pendingRoot(root)
  const dirs = readdirSync(pending).filter((f) => !f.startsWith('.'))
  expect(dirs.sort()).toEqual(['0001-第1章', '0002-第2章'])

  // 每章目录有草稿 + 细纲
  for (const d of dirs) {
    expect(existsSync(join(pending, d, '草稿-1.md'))).toBe(true)
    expect(existsSync(join(pending, d, '细纲.md'))).toBe(true)
  }

  // 工作区根应已清空（草稿/细纲搬走了）
  const workDirFiles = readdirSync(join(root, '工作区')).filter((f) => !f.startsWith('.') && f !== '待定稿')
  expect(workDirFiles).toHaveLength(0)

  rmSync(root, { recursive: true, force: true })
})

test('moveToPending: 账本推进.md 随章搬入待定稿', () => {
  const root = makeBookWithVolumeOutline()
  const workDir = join(root, '工作区')
  writeFileSync(join(workDir, '账本推进.md'), '- 伏笔-001 埋下：信在桌上\n', 'utf-8')

  const dir = moveToPending(workDir, root, 1, '第一章')

  expect(existsSync(join(dir, '账本推进.md'))).toBe(true)
  expect(existsSync(join(workDir, '账本推进.md'))).toBe(false)

  rmSync(root, { recursive: true, force: true })
})

test('连写: 章号从既有定稿续算（不从1开始）', async () => {
  const root = makeBookWithVolumeOutline()
  // 先手工造一章定稿（ch:0005）
  writeFileSync(join(root, '定稿', '正文', '0005-第五章.md'), '---\n章号: 5\n---\n正文', 'utf-8')
  execSync('git add -A && git commit -m "ch:0005 第五章"', { cwd: root, stdio: 'pipe' })

  const r = await doAutoBatch({ bookRoot: root, targetCount: 2, produce: makeProduceStub() })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.start_chapter).toBe(6) // 从第6章起
  expect(r.produced).toEqual([6, 7])

  rmSync(root, { recursive: true, force: true })
})

test('连写: 最近 20 条非章提交不影响下一章号（定稿目录是真源）', async () => {
  const root = makeBookWithVolumeOutline()
  writeFileSync(join(root, '定稿', '正文', '0005-第五章.md'), '---\n章号: 5\n---\n正文', 'utf-8')
  execSync('git add -A && git commit -m "ch:0005 第五章"', { cwd: root, stdio: 'pipe' })
  for (let i = 0; i < 21; i++) {
    writeFileSync(join(root, '大纲', '卷纲', `杂项-${i}.md`), `杂项 ${i}`, 'utf-8')
    execSync(`git add -A && git commit -m "docs: 杂项 ${i}"`, { cwd: root, stdio: 'pipe' })
  }

  const r = await doAutoBatch({ bookRoot: root, targetCount: 1, produce: makeProduceStub() })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.progress.start_chapter).toBe(6)
  expect(r.produced).toEqual([6])

  rmSync(root, { recursive: true, force: true })
})

test('连写: 卷纲为空 → 拒绝启动', async () => {
  const root = mkdtempSync(join(tmpdir(), '无纲-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true }) // 空卷纲
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })

  const r = await doAutoBatch({ bookRoot: root, targetCount: 2, produce: makeProduceStub() })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('卷纲')

  rmSync(root, { recursive: true, force: true })
})

test('连写: 已有未完批次 → 拒绝静默覆盖', async () => {
  const root = makeBookWithVolumeOutline()
  // 先跑一批（target=3，但只产出1章就停——用提前返回的桩）
  let callCount = 0
  const stopEarly = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | null> => {
    callCount++
    if (chapter > 1) return null // 第2章停止
    return await makeProduceStub()({ chapter })
  }
  await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stopEarly })
  // 批次未完（completed=[1], target=3）

  // 再开新批应拒绝
  const r = await doAutoBatch({ bookRoot: root, targetCount: 2, produce: makeProduceStub() })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('未完批次')

  rmSync(root, { recursive: true, force: true })
})

test('连写 --resume: 续跑未完批次，进度继承', async () => {
  const root = makeBookWithVolumeOutline()
  // 先跑一批，第2章停止
  let phase = 1
  const stopAt2 = async ({ chapter }: { chapter: number }): Promise<ChapterProduction | null> => {
    if (phase === 1 && chapter >= 2) return null
    return await makeProduceStub()({ chapter })
  }
  const r1 = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: stopAt2 })
  expect(r1.ok).toBe(true)
  if (!r1.ok) return
  expect(r1.produced).toEqual([1]) // 只产出第1章就停

  // resume 续跑（清暂停 + 从 next_chapter=2 继续）
  phase = 2
  const r2 = await doAutoBatch({ bookRoot: root, targetCount: 3, produce: makeProduceStub(), resume: true })
  expect(r2.ok).toBe(true)
  if (!r2.ok) return
  expect(r2.produced).toEqual([2, 3]) // 续写第2、3章
  expect(r2.progress.completed).toEqual([1, 2, 3]) // 进度继承（含第1章）

  rmSync(root, { recursive: true, force: true })
})

test('整批回滚: 清待定稿不涉 git', async () => {
  const root = makeBookWithVolumeOutline()
  await doAutoBatch({ bookRoot: root, targetCount: 2, produce: makeProduceStub() })
  expect(existsSync(pendingRoot(root))).toBe(true)

  const r = clearPendingBatch(root)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.cleared).toBe(2)
  expect(existsSync(pendingRoot(root))).toBe(false)

  // git 历史不变（只有 init commit）
  const log = execSync('git log --oneline', { cwd: root, stdio: 'pipe' }).toString().trim()
  expect(log.split('\n')).toHaveLength(1)

  rmSync(root, { recursive: true, force: true })
})

test('readBatchProgress: 容错（坏文件返回 null 不崩）', () => {
  const root = makeBookWithVolumeOutline()
  mkdirSync(pendingRoot(root), { recursive: true })
  writeFileSync(join(pendingRoot(root), '.auto-batch.json'), '这不是JSON', 'utf-8')
  expect(readBatchProgress(root)).toBeNull()

  rmSync(root, { recursive: true, force: true })
})

test('writeBatchProgress: .auto-batch.json 原子写入且不残留临时文件', () => {
  const root = makeBookWithVolumeOutline()
  writeBatchProgress(root, {
    start_chapter: 1,
    target_count: 2,
    next_chapter: 1,
    completed: [],
    isolated: [],
    paused: null,
    started_at: '2026-06-19T00:00:00.000Z',
  })

  expect(readBatchProgress(root)?.target_count).toBe(2)
  const leftovers = readdirSync(pendingRoot(root)).filter((f) => f.includes('.auto-batch.json') && f.endsWith('.tmp'))
  expect(leftovers).toEqual([])

  rmSync(root, { recursive: true, force: true })
})
