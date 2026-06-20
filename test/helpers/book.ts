/**
 * 书仓库测试 fixture 工具 —— M3 7 态测试共用。
 *
 * 迁自 test/finalize/commit.test.ts 的 makeGitBook（git init + book.yaml + 目录 + 账本 + 初始 commit），
 * 扩展为可造「多章多 commit」书（回滚测试用）+ 各态 fixture 的造态钩子。
 *
 * 设计：每个 make* 返回书仓库根路径，调用方用完自行 rmSync 清理（与现有测试一致）。
 * 全程中文目录名（验证中文路径全链路，沿用 rebuild.test 约定）。
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

/** 跑一条 git 命令（fixture 用，stdio pipe 免污染测试输出） */
export function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git ${args.join(' ')} failed`)
  return r.stdout
}

/**
 * 造一个干净的书仓库（git init + book.yaml + 目录骨架 + 1 条账本 + 初始 commit）。
 * 缓存按「可重建派生」原则**不**预建——状态机/重建器自己 rebuild。
 * 这是所有 fixture 的基础形态（对应状态机态 7：一切干净 → 起草新章）。
 */
export function makeGitBook(opts?: { withCache?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))

  // git init + 身份（fixture 隔离，不污染全局 git config）
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)

  // book.yaml
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)

  // 目录骨架（母本第 5 节数据形态）
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '大纲', '悬念'), { recursive: true })
  mkdirSync(join(root, '大纲', '感情线'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true }) // 缓存目录常建（测试可直接建 db）

  // 1 条账本（基础类，恒启用）
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
    'utf-8',
  )

  // 可选：预建缓存（某些测试需要缓存已存在再造态，如「.cache 与 md 不一致」）
  if (opts?.withCache) {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    createAllTables(db)
    syncLead(db, {
      编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 1,
      履历: [{ 章号: 1, 动词: '埋下', 证据: '焦痕' }],
      _path: join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    })
    db.close()
  }

  // 初始 commit（git 干净基线）
  git(['add', '-A'], root)
  git(['commit', '-m', 'init'], root)

  return root
}

/**
 * 造一个写了 N 章并逐章定稿 commit 的书仓库（回滚「回到第 N 章」测试用）。
 * 每章一个 `ch:<补零章号>` commit（对齐 #16 第 4 节 commit msg 规范，回滚靠它定位）。
 *
 * @param n 已定稿的章数（1..n）
 * @returns 书仓库根；定稿区有 n 章正文 + n 个 ch: commit
 */
export function makeGitBookWithChapters(n: number): string {
  const root = makeGitBook()

  for (let i = 1; i <= n; i++) {
    const chNo = String(i).padStart(4, '0')
    const title = `第${i}章`
    // 正文（含 #7 front matter）
    writeFileSync(
      join(root, '定稿', '正文', `${chNo}-${title}.md`),
      `---\n章号: ${i}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${i}章的正文内容。\n`,
      'utf-8',
    )
    // commit（#16 第 4 节前缀 + 章号，回滚按 ch:<章号> 反查）
    git(['add', '-A'], root)
    git(['commit', '-m', `ch:${chNo} ${title}`], root)
  }

  return root
}

/**
 * 在已有书仓库里「定稿一章但不 commit」（造态 4「工作区未完成」的中断场景）。
 * 写草稿 + 细纲 + .confirm.json，但不 commit —— 模拟 finalize 步骤 1-2 中断。
 */
export function stageIncompleteChapter(root: string, chapterNum: number): void {
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, `第${chapterNum}章细纲`, 'utf-8')
  writeFileSync(join(workDir, '草稿-1.md'), `第${chapterNum}章草稿`, 'utf-8')
  // .confirm.json（机器域，模拟已确认细纲但未定稿）
  writeFileSync(
    join(workDir, '.confirm.json'),
    JSON.stringify({
      chapter: chapterNum,
      outline_hash: 'sha256:fixture',
      confirmed_at: '2026-06-17T10:00:00.000Z',
      mode: 'manual',
    }),
    'utf-8',
  )
}

/** 同步章节进缓存（部分测试需要缓存里有章节记录，如续跑判定读 currentChapter） */
export function seedChapterToCache(root: string, chapterNum: number, title: string): void {
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  if (!existsSync(join(root, '.cache'))) mkdirSync(join(root, '.cache'), { recursive: true })
  createAllTables(db)
  syncChapter(db, {
    章号: chapterNum, 标题: title, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
  })
  db.close()
}
