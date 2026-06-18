/**
 * 书仓库 scaffold —— 从 init.ts 提取的共享模块（M7 #36 复用边界）。
 *
 * init（#30）和 import（#36）都通过这里建书仓库，保证 6.2 目录树、
 * 文风铁律模板、书级 AGENTS.md、git init + 身份隔离、init commit 完全一致。
 *
 * 行为契约：本模块只负责「建书仓库骨架」，不含工作目录 scaffold、
 * 不装角色壳、不登记 books.jsonl（那些是 doInit 编排层的事）。
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../format/yaml.js'
import { BASE_LEAD_TYPES } from './data.js'
import type { BookConfig, LeadType } from '../format/types.js'

/** 书仓库 scaffold 入参（init 和 import 共用）。 */
export interface BookScaffoldOpts {
  name: string
  genre: string
  leadsEnabled: LeadType[]
  kind: 'long' | 'short'
}

/**
 * 建书仓库骨架（独立 git + book.yaml + 6.2 目录 + 文风冷启动 + 初始 commit）。
 *
 * 产物：book.yaml、.gitignore、AGENTS.md、定稿/大纲/文风/工作区 全套目录、
 * `git commit -m "init"` 作为 HEAD（让 enter/状态机有 HEAD 可判）。
 */
export function scaffoldBookRepo(bookRoot: string, opts: BookScaffoldOpts): void {
  mkdirSync(bookRoot, { recursive: true })

  // git init + 身份（隔离，不污染全局 config）
  execSync('git init', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.email author@clwriting.local', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.name author', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: bookRoot, stdio: 'pipe' })

  // book.yaml（#9 schema，题材驱动 leads.enabled）
  const config: BookConfig = {
    ...DEFAULT_CONFIG,
    book: { ...DEFAULT_CONFIG.book, title: opts.name, genre: opts.genre },
    leads: { ...DEFAULT_CONFIG.leads, enabled: opts.leadsEnabled },
    ...(opts.kind === 'short' ? { kind: 'short' } : {}),
  }
  writeBookConfig(join(bookRoot, 'book.yaml'), config)

  // 母本 6.2 目录：定稿 / 大纲 / 文风 / 工作区
  scaffoldDirectories(bookRoot, opts)

  // .gitignore（工作区/临时区/缓存/RAG 向量库不进 git）
  writeFileSync(
    join(bookRoot, '.gitignore'),
    ['工作区/', '.cache/', '.rag.db', ''].join('\n'),
    'utf-8',
  )

  // 书仓库层 AGENTS.md（书级指路，非 #21 派生）
  writeFileSync(join(bookRoot, 'AGENTS.md'), renderBookAgentsMd(opts), 'utf-8')

  // 初始 commit（让 enter/状态机有 HEAD 可判，避开态 3 误判）
  execSync('git add -A', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git commit -m "init"', { cwd: bookRoot, stdio: 'pipe' })
}

/** 建母本 6.2 目录树（基础三类恒建 + 扩展类按 leadsEnabled 建）。 */
export function scaffoldDirectories(bookRoot: string, opts: BookScaffoldOpts): void {
  // 定稿区
  for (const d of ['定稿/正文', '定稿/摘要/章摘要', '定稿/摘要/卷摘要', '定稿/设定/角色', '定稿/设定/时间线']) {
    mkdirSync(join(bookRoot, ...d.split('/')), { recursive: true })
  }
  writeFileSync(join(bookRoot, '定稿', '设定', '世界观.md'), '# 世界观\n\n（待补）\n', 'utf-8')
  writeFileSync(join(bookRoot, '定稿', '设定', '境界体系.md'), '', 'utf-8')
  writeFileSync(join(bookRoot, '定稿', '设定', '名册.md'), '# 人物名册\n\n（待补）\n', 'utf-8')

  // 大纲：基础三类恒建 + 扩展类按启用
  mkdirSync(join(bookRoot, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '感情线'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲\n\n（待补）\n', 'utf-8')
  for (const lead of opts.leadsEnabled) {
    mkdirSync(join(bookRoot, '大纲', lead), { recursive: true })
  }

  // 文风冷启动占位（O2）：五场景空目录 + 文风铁律骨架
  for (const scene of ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']) {
    mkdirSync(join(bookRoot, '文风', '样章库', scene), { recursive: true })
  }
  mkdirSync(join(bookRoot, '文风', '金句库'), { recursive: true })
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), renderStyleRules(opts.genre), 'utf-8')

  // 工作区（临时区，gitignore）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
}

/** 文风铁律模板（冷启动占位，作者后续按本书调性补）。 */
export function renderStyleRules(_genre: string): string {
  return [
    '# 文风铁律',
    '',
    '## 反和解段（AI 味防御）',
    '',
    '（待作者补：本章不可出现的套话/AI 味词汇清单）',
    '',
    '## 可量化约束',
    '',
    '- 对话占比：目标 30–50%',
    '- 平均句长：目标 15–25 字',
    '- （待作者按本书调性补）',
    '',
  ].join('\n')
}

/** 书仓库层 AGENTS.md（书级指路）。 */
export function renderBookAgentsMd(opts: BookScaffoldOpts): string {
  const leadsList = [...BASE_LEAD_TYPES, ...opts.leadsEnabled]
  return [
    `# ${opts.name}`,
    '',
    `这是 CLWriting 书仓库。题材：${opts.genre || '（未指定）'}。`,
    '',
    '## 配置',
    '',
    '`book.yaml` 是机器域配置（经对话改，不手编）。当前启用账本类：',
    `- ${leadsList.join('、')}`,
    '',
    '## 下一步',
    '',
    '运行 `clwriting enter` 看这本书写到哪、下一步干啥。',
    '',
  ].join('\n')
}

/**
 * 向上查找最近的含 .git 的祖先目录（git 仓库定位）。
 * 命中返回该目录路径，否则 null。
 *
 * 用途：建书仓库前防护——工作目录不能位于某个 git 仓库内，
 * 否则书仓库的 git init 会被外层 git 当子模块/嵌入仓库，破坏隔离模型。
 */
export function findGitAncestor(startDir: string): string | null {
  let dir = resolve(startDir)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  for (;;) {
    const gitPath = join(dir, '.git')
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath)
        if (stat.isDirectory() || stat.isFile()) return dir
      } catch {
        return dir
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
