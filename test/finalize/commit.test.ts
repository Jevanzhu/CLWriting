import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm, confirmPath } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import { aiCallBudgetPath, recordAiCall } from '../../src/ai/calls.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

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

function addGrowthFixture(root: string, config: BookConfig = growthConfig()): void {
  writeBookConfig(join(root, 'book.yaml'), config)
  mkdirSync(join(root, '大纲', '成长线'), { recursive: true })
  mkdirSync(join(root, '定稿', '设定'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
  writeFileSync(
    join(root, '定稿', '设定', '境界体系.md'),
    '---\n体系:\n  - 名称: 修真境界\n    序列: [炼气一层, 炼气二层, 筑基]\n---\n\n修真境界。\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '大纲', '成长线', '成长线-001-陆沉修为.md'),
    '---\n编号: 成长线-001\n标题: 陆沉修为\n类型: 成长线\n状态: 进行中\n开启章: 1\n境界体系: 修真境界\n当前境界: 炼气一层\n---\n\n## 履历\n\n- 第001章 起步：踏入炼气一层\n',
    'utf-8',
  )
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  syncLead(db, {
    编号: '成长线-001',
    标题: '陆沉修为',
    类型: '成长线',
    状态: '进行中',
    开启章: 1,
    境界体系: '修真境界',
    当前境界: '炼气一层',
    履历: [{ 章号: 1, 动词: '起步', 证据: '踏入炼气一层' }],
    _path: join(root, '大纲', '成长线', '成长线-001-陆沉修为.md'),
  })
  db.close()
  execSync('git add -A && git commit -m "growth fixtures"', { cwd: root, stdio: 'pipe' })
}

function growthConfig(overrides: Partial<BookConfig> = {}): BookConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    leads: { ...DEFAULT_CONFIG.leads, enabled: ['成长线'], ...(overrides.leads ?? {}) },
    growth: { ...DEFAULT_CONFIG.growth, realm_span_max: 2, ...(overrides.growth ?? {}) },
  }
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

test('doFinalize: 完整机检红项未过 → 禁词在 finalize 路径拦截', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 硬禁词清单\n- 禁句\n', 'utf-8')
  writeFileSync(outline, '第1章细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文里有禁句。', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('命中禁词「禁句」')
  expect(existsSync(join(root, '定稿', '正文', '1-第一章.md'))).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 全通过 → 原子 commit + 正文入定稿 + 工作区清空', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '---\n章号: 1\n推进: [伏笔-031]\n---\n第1章细纲', 'utf-8')

  // 确认细纲
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  // 写草稿/审稿（模拟工作区有文件）
  writeFileSync(join(workDir, '草稿-1.md'), '草稿', 'utf-8')
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')
  recordAiCall({ workDir, chapter: 1, config: DEFAULT_CONFIG, step: 'outline', at: '2026-06-18T00:00:00.000Z' })
  expect(existsSync(aiCallBudgetPath(workDir))).toBe(true)

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
    expect(existsSync(aiCallBudgetPath(workDir))).toBe(false)
    // commit 有确认留痕 trailer
    const log = execSync('git log -1 --format=%B', { cwd: root, encoding: 'utf-8' })
    // #16 第 4 节 commit msg 规范：ch:<4位补零章号> <标题>
    expect(log).toMatch(/^ch:0001 第一章/)
    // trailer 格式（#16 第 4 节）：Confirmed: <时间> mode=<模式> hash=<细纲哈希>
    expect(log).toContain('Confirmed:')
    expect(log).toContain('mode=manual')
    expect(log).toContain('hash=sha256:')
  }
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 目标章号已定稿 → 拒绝覆盖已有正文', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(join(root, '定稿', '正文', '1-旧章.md'), '---\n章号: 1\n---\n旧正文有焦痕', 'utf-8')
  execSync('git add -A && git commit -m "ch:0001 旧章"', { cwd: root, stdio: 'pipe' })
  writeFileSync(outline, '第1章新细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  const ch: ChapterMeta = {
    章号: 1, 标题: '新章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '新正文提到焦痕。', fileName: '1-新章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('已定稿')
  expect(existsSync(join(root, '定稿', '正文', '1-新章.md'))).toBe(false)
  expect(readFileSync(join(root, '定稿', '正文', '1-旧章.md'), 'utf-8')).toContain('旧正文')
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

test('doFinalize: 定稿中断（git 失败）→ 错误且工作区原样保留（原子性，#13 第 5 节）', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)
  writeFileSync(join(workDir, '草稿-1.md'), '草稿', 'utf-8')
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')

  // 破坏 git 仓库 → addCommit 失败，模拟定稿在原子点中断
  rmSync(join(root, '.git'), { recursive: true, force: true })

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(false) // commit 失败 = 中断
  // 工作区原样保留（未被 clearWorkDir 清空）：可续跑/可回滚（M3）
  expect(existsSync(join(workDir, '草稿-1.md'))).toBe(true)
  expect(existsSync(join(workDir, '细纲.md'))).toBe(true)
  expect(existsSync(confirmPath(workDir))).toBe(true)
  // 定稿区原子回滚（P0-2）：commit 失败时 #2 写入的新文件被撤销，定稿区无变化
  expect(existsSync(join(root, '定稿', '正文', '1-第一章.md'))).toBe(false)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: commit 被 hook 拒绝（git 完好）→ 定稿区原子回滚，已跟踪账本恢复原状', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '---\n章号: 1\n推进: [伏笔-031]\n---\n细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  // 账本原始内容（用于断言恢复）
  const leadPath = join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md')
  const leadBefore = readFileSync(leadPath, 'utf-8')

  // 装 pre-commit hook 让 commit 失败（git 完好，模拟真实 commit 被拒）
  const hookDir = join(root, '.git', 'hooks')
  mkdirSync(hookDir, { recursive: true })
  writeFileSync(join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n')
  try {
    chmodSync(join(hookDir, 'pre-commit'), 0o755)
  } catch {
    // Windows 下权限位可能不可用；Git for Windows 仍会读取 hook 文件。
  }

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-第一章.md', hasReviewVerdict: true,
    chapterSummary: '摘要',
    leadUpdates: [{ leadId: '伏笔-031', entries: [{ 章号: 1, 动词: '推进', 证据: '焦痕' }] }],
  })
  expect(r.ok).toBe(false) // hook 拒绝 commit
  if (!r.ok) expect(r.reason).toContain('git 操作失败')
  // 定稿区原子回滚（#13 第 4 节）：commit 失败则定稿区无变化
  // 新建的正文/摘要被删除
  expect(existsSync(join(root, '定稿', '正文', '1-第一章.md'))).toBe(false)
  expect(existsSync(join(root, '定稿', '摘要', '章摘要', '1.md'))).toBe(false)
  // 已跟踪的账本文件恢复到 HEAD 版本（履历未被污染）
  expect(normalizeEol(readFileSync(leadPath, 'utf-8'))).toBe(normalizeEol(leadBefore))
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: leadUpdates 写入履历 + 幂等去重 + 跨章跳过', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '---\n章号: 1\n推进: [伏笔-031]\n---\n细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)

  const ch: ChapterMeta = {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '焦痕。', fileName: '1-第一章.md', hasReviewVerdict: true,
    leadUpdates: [{ leadId: '伏笔-031', entries: [
      { 章号: 1, 动词: '推进', 证据: '焦痕一' },
      { 章号: 1, 动词: '推进', 证据: '焦痕二' }, // 同章同动词 → 幂等去重
      { 章号: 99, 动词: '推进', 证据: '跨章' }, // 非本章 → 跳过
    ]}],
  })
  expect(r.ok).toBe(true)
  const leadContent = readFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'), 'utf-8')
  expect(leadContent.match(/推进/g)?.length).toBe(1) // 幂等：只写一条
  expect(leadContent).not.toContain('跨章') // 跨章 entry 被跳过
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 成长线跨层落履历时同步当前境界 front matter', () => {
  const root = makeGitBook()
  const config = growthConfig()
  addGrowthFixture(root, config)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '---\n章号: 2\n推进: [成长线-001]\n---\n细纲', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', config)

  const ch: ChapterMeta = {
    章号: 2, 标题: '暗流', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root,
    workDir,
    outlinePath: outline,
    db,
    config,
    chapter: ch,
    body: '陆沉突破至炼气二层，观微镜光芒一闪。',
    fileName: '2-暗流.md',
    hasReviewVerdict: true,
    leadUpdates: [{ leadId: '成长线-001', entries: [{ 章号: 2, 动词: '跨层', 证据: '突破至炼气二层' }] }],
  })

  expect(r.ok).toBe(true)
  const leadContent = readFileSync(join(root, '大纲', '成长线', '成长线-001-陆沉修为.md'), 'utf-8')
  expect(leadContent).toContain('当前境界: 炼气二层')
  expect(leadContent).toContain('第002章 跨层：突破至炼气二层')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 成长线跨层证据必须使用境界体系精确值', () => {
  const root = makeGitBook()
  const config = growthConfig()
  addGrowthFixture(root, config)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '---\n章号: 2\n推进: [成长线-001]\n---\n细纲', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', config)

  const ch: ChapterMeta = {
    章号: 2, 标题: '筑基', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  }
  const r = doFinalize({
    bookRoot: root,
    workDir,
    outlinePath: outline,
    db,
    config,
    chapter: ch,
    body: '陆沉突破至筑基初期，气息大涨。',
    fileName: '2-筑基.md',
    hasReviewVerdict: true,
    leadUpdates: [{ leadId: '成长线-001', entries: [{ 章号: 2, 动词: '跨层', 证据: '突破至筑基初期' }] }],
  })

  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('精确境界值')
  const leadContent = readFileSync(join(root, '大纲', '成长线', '成长线-001-陆沉修为.md'), 'utf-8')
  expect(leadContent).toContain('当前境界: 炼气一层')
  expect(leadContent).not.toContain('第002章')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('doFinalize: 卷末自动生成卷摘要', () => {
  const root = makeGitBook()
  const config: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 2 } }
  writeBookConfig(join(root, 'book.yaml'), config)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(join(root, '定稿', '正文', '1-开端.md'), '---\n章号: 1\n标题: 开端\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第一章正文有焦痕。', 'utf-8')
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '1.md'), '第一章摘要。', 'utf-8')
  execSync('git add -A && git commit -m "ch:0001 开端"', { cwd: root, stdio: 'pipe' })
  writeFileSync(outline, '---\n章号: 2\n---\n细纲', 'utf-8')
  doConfirm(workDir, 2, outline, 'manual', config)

  const ch: ChapterMeta = {
    章号: 2, 标题: '卷末', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折',
  }
  const r = doFinalize({
    bookRoot: root,
    workDir,
    outlinePath: outline,
    db,
    config,
    chapter: ch,
    body: '第二章卷末正文。',
    fileName: '2-卷末.md',
    hasReviewVerdict: true,
    chapterSummary: '第二章摘要。',
  })

  expect(r.ok).toBe(true)
  const volumeSummary = readFileSync(join(root, '定稿', '摘要', '卷摘要', '1.md'), 'utf-8')
  expect(volumeSummary).toContain('第1卷摘要')
  expect(volumeSummary).toContain('第一章摘要')
  expect(volumeSummary).toContain('第二章摘要')
  db.close()
  rmSync(root, { recursive: true, force: true })
})
