import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

/** 造一个完整的书仓库（含 git init） */
function makeGitBook(): string {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))
  // git init
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email test@test.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name test', { cwd: root, stdio: 'pipe' })

  // book.yaml
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)

  // 目录结构
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })

  // 缓存
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '埋下', 证据: '焦痕' }], _path: join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
  })
  db.close()

  // 账本文件
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
    'utf-8',
  )

  // 初始 commit
  execSync('git add -A', { cwd: root, stdio: 'pipe' })
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' })

  return root
}

test('doFinalize: 前置闸未过（无审稿裁决）→ 拒绝', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲内容', 'utf-8')

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文内容', fileName: '1-第一章.md', hasReviewVerdict: false,
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('拍板')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 前置闸未过（无确认记录）→ 拒绝', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲内容', 'utf-8')

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文内容', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('拍板') // 无确认 → "细纲还没拍板"
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 全通过 → 原子 commit + 正文入定稿 + 工作区清空', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第1章细纲', 'utf-8')

  // 确认细纲
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  // 写草稿/审稿（模拟工作区有文件）
  writeFileSync(join(workDir, '草稿-1.md'), '草稿', 'utf-8')
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '林晚踏入北境，雪落无声。', fileName: '1-第一章.md', hasReviewVerdict: true,
    chapterSummary: '林晚抵达北境。',
    leadUpdates: [{ leadId: '伏笔-031', entries: [{ 章号: 1, 动词: '推进', 证据: '焦痕' }] }],
  })

  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.commitHash).toMatch(/^[0-9a-f]{7,40}$/)
    // 正文入定稿
    expect(existsSync(join(root, '定稿', '正文', '1-第一章.md'))).toBe(true)
    const chapterContent = readFileSync(join(root, '定稿', '正文', '1-第一章.md'), 'utf-8')
    expect(chapterContent).toContain('林晚踏入北境')
    // 章摘要入定稿
    expect(existsSync(join(root, '定稿', '摘要', '章摘要', '1.md'))).toBe(true)
    // 工作区已清空（草稿/细纲/审稿没了）
    expect(existsSync(join(workDir, '草稿-1.md'))).toBe(false)
    expect(existsSync(join(workDir, '细纲.md'))).toBe(false)
    expect(existsSync(join(workDir, '审稿.md'))).toBe(false)
    // commit 有确认留痕 trailer
    const log = execSync('git log -1 --format=%B', { cwd: root, encoding: 'utf-8' })
    expect(log).toContain('Confirmed:')
    expect(log).toContain('mode=manual')
  }
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 细纲确认后被篡改 → 前置闸拦截', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '原始细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  // 篡改细纲
  writeFileSync(outline, '被篡改的细纲', 'utf-8')

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('改过了')
  db.close()
  rmSync(root, { recursive: true, force: true })
})
