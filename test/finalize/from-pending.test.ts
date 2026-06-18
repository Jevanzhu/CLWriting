import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { readReviewVerdict, REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import { finalizeCommand } from '../../src/cli/finalize.js'

/**
 * R2（#35）：finalize --from <待定稿章目录> 从待定稿定稿，doFinalize 内核零改动。
 * 待定稿章 = 单章工作区快照（.confirm.json/草稿-1.md/审稿.md），workDir 指向它，
 * finalize 前置闸（审稿裁决 + 确认哈希 + 账本形式三检）逐条照跑。
 */

/** 建一本有第 1 章定稿的书（让账本形式三检有 HEAD 可比对）。 */
function makeBookWithChapter1(): string {
  const root = mkdtempSync(join(tmpdir(), '从待定稿-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })

  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })

  // 缓存：第 1 章已定稿
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '埋下', 证据: '焦痕' }],
    _path: join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
  })
  syncChapter(db, { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' })
  db.close()

  // 账本 md
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
    'utf-8',
  )
  execSync('git add -A && git commit -m "init"', { cwd: root, stdio: 'pipe' })
  return root
}

test('R2: finalize --from 待定稿章目录 → 原子 commit 成功', () => {
  const root = makeBookWithChapter1()
  // 造待定稿章目录（第 2 章），含确认+草稿+审稿approved
  const pendingDir = join(root, '工作区', '待定稿', '0002-第二章')
  mkdirSync(pendingDir, { recursive: true })
  writeFileSync(
    join(root, '工作区', '待定稿', '.auto-batch.json'),
    JSON.stringify({
      start_chapter: 2,
      target_count: 1,
      next_chapter: 3,
      completed: [2],
      isolated: [],
      paused: null,
      started_at: '2026-06-19T00:00:00Z',
    }),
    'utf-8',
  )
  const outline = join(pendingDir, '细纲.md')
  writeFileSync(outline, '第2章细纲。', 'utf-8')
  doConfirm(pendingDir, 2, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(
    join(pendingDir, '草稿-1.md'),
    '---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第2章正文。\n',
    'utf-8',
  )
  // 审稿裁决 approved
  writeFileSync(
    join(pendingDir, '审稿.md'),
    `# 审稿单\n\n\`\`\`\n${REVIEW_VERDICT_MARKER} verdict: 通过\n\`\`\`\n`,
    'utf-8',
  )

  // finalize --from
  finalizeCommand(['--from', pendingDir])

  // 定稿区有第 2 章
  expect(existsSync(join(root, '定稿', '正文', '2-第二章.md'))).toBe(true)
  // git 有 ch:0002 commit
  const log = execSync('git log --oneline', { cwd: root, stdio: 'pipe' }).toString()
  expect(log).toContain('ch:0002')
  // 直连 --from 成功后清理待定稿章目录，并从批次进度移除
  expect(existsSync(pendingDir)).toBe(false)
  const progress = JSON.parse(readFileSync(join(root, '工作区', '待定稿', '.auto-batch.json'), 'utf-8')) as { completed: number[] }
  expect(progress.completed).toEqual([])

  rmSync(root, { recursive: true, force: true })
})

test('R2: finalize --from 未裁决章 → 前置闸拦「还没拍板」', () => {
  const root = makeBookWithChapter1()
  const pendingDir = join(root, '工作区', '待定稿', '0002-第二章')
  mkdirSync(pendingDir, { recursive: true })
  const outline = join(pendingDir, '细纲.md')
  writeFileSync(outline, '第2章细纲。', 'utf-8')
  doConfirm(pendingDir, 2, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(
    join(pendingDir, '草稿-1.md'),
    '---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )
  // 不写审稿.md（未裁决）

  // finalize --from 应被前置闸拦（process.exit → 抛错）
  expect(() => finalizeCommand(['--from', pendingDir])).toThrow()
  // 定稿区无第 2 章
  expect(existsSync(join(root, '定稿', '正文', '2-第二章.md'))).toBe(false)

  rmSync(root, { recursive: true, force: true })
})

test('R2: --from 路径找不到书仓库 → 报错', () => {
  const empty = mkdtempSync(join(tmpdir(), '无书-'))
  const pendingDir = join(empty, '某章')
  mkdirSync(pendingDir, { recursive: true })
  // 无 book.yaml 的目录
  expect(() => finalizeCommand(['--from', pendingDir])).toThrow()
  rmSync(empty, { recursive: true, force: true })
})

test('R2: 无 --from 时 workDir 仍是工作区根（不破坏既有用法）', () => {
  const root = makeBookWithChapter1()
  // 工作区根造第 2 章（既有单章定稿路径）
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第2章细纲。', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(
    join(workDir, '草稿-1.md'),
    '---\n章号: 2\n标题: 第二章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )
  writeFileSync(
    join(workDir, '审稿.md'),
    `# 审稿单\n\n\`\`\`\n${REVIEW_VERDICT_MARKER} verdict: 通过\n\`\`\`\n`,
    'utf-8',
  )

  // 既有用法（无 --from，传书目录参数）应照常工作
  finalizeCommand([root])
  expect(existsSync(join(root, '定稿', '正文', '2-第二章.md'))).toBe(true)

  rmSync(root, { recursive: true, force: true })
})
