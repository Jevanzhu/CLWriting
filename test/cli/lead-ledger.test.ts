/**
 * 账本 CLI 接缝 端到端回归测试 —— 补「CLI 跑完账本真落盘」缺口。
 *
 * 这条端到端用例正是此前缺失、致 515 单元测试漏过接缝缺口的那条：
 * check/finalize 的 CLI 薄门面此前不装配 declaredLeadIds/actualLeadIds/leadUpdates，
 * 致长篇账本「防吃书」在端到端流程整条失效。
 */

import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeChapter } from '../../src/format/chapters.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import { finalizeCommand } from '../../src/cli/finalize.js'
import { checkCommand } from '../../src/cli/check.js'
import type { ChapterMeta } from '../../src/format/types.js'

const CH1: ChapterMeta = { 章号: 1, 标题: '来信', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

function makeLongBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-账本-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', {
    cwd: root,
    stdio: 'pipe',
  })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 捕获 console + process.exit */
function captureCli(run: () => void): { stdout: string; exitCode: string | null } {
  const out: string[] = []
  let exitCode: string | null = null
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = String(code ?? '')
    throw new Error(`process.exit ${exitCode}`)
  }) as typeof process.exit)
  try {
    run()
  } catch {
    // process.exit 抛出
  } finally {
    log.mockRestore()
    err.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join('\n'), exitCode }
}

/** 建本章账本声明三件套（账本文件 + 细纲推进 + 账本推进.md + 草稿） */
function stageChapter(root: string, opts: { 推进: string; 兑现: boolean; 证据命中: boolean }): void {
  const wd = join(root, '工作区')
  // 账本文件（进行中、履历空——本章埋下）
  writeFileSync(
    join(root, '大纲', '伏笔', '伏笔-040-神秘信件.md'),
    '---\n编号: 伏笔-040\n标题: 神秘信件\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  // 细纲：front matter 声明 推进
  writeFileSync(
    join(wd, '细纲.md'),
    `---\n章号: 1\n标题: 来信\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 对话\n推进: [${opts.推进}]\n---\n本章埋下神秘信件。`,
    'utf-8',
  )
  // 草稿：证据命中与否
  const body = opts.证据命中
    ? '夜里，桌上多了一封没有署名的信。她盯着那行字，久久没动，窗外风声渐紧，远处传来一声闷响。'
    : '今天天气不错，他出门散步，沿着河堤走了很久，看孩子们放风筝，心里渐渐松快下来。'
  writeChapter(join(wd, '草稿-1.md'), CH1, body)
  // 账本推进.md：兑现与否
  if (opts.兑现) {
    writeFileSync(join(wd, '账本推进.md'), '- 伏笔-040 埋下：桌上多了一封没有署名的信\n', 'utf-8')
  }
  doConfirm(wd, 1, join(wd, '细纲.md'), 'manual', DEFAULT_CONFIG)
  writeFileSync(join(wd, '审稿.md'), `${REVIEW_VERDICT_MARKER} verdict: 通过\n`, 'utf-8')
}

test('finalize CLI long: 账本履历经 CLI 真落盘 + 进 commit（接缝核心回归）', () => {
  const root = makeLongBook()
  try {
    stageChapter(root, { 推进: '伏笔-040', 兑现: true, 证据命中: true })
    const { exitCode } = captureCli(() => finalizeCommand([root]))
    expect(exitCode).toBeNull()

    // 账本文件含本章履历（落盘）——此前缺口下永不写入
    const lead = readFileSync(join(root, '大纲', '伏笔', '伏笔-040-神秘信件.md'), 'utf-8')
    expect(lead).toContain('埋下')
    expect(lead).toContain('桌上多了一封没有署名的信')

    // 账本文件进 commit（精确 add 不再漏账本）。quotepath=false 让 git 输出中文原文不转八进制
    const files = execSync('git -c core.quotepath=false show --name-only --format= HEAD', { cwd: root, encoding: 'utf-8' })
    expect(files).toContain('伏笔-040-神秘信件.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check CLI long: 细纲声明推进但未兑现 → 两端闭合报红（exit 1）', () => {
  const root = makeLongBook()
  try {
    // 声明推进 伏笔-040，但不建账本推进.md（没兑现）+ 正文不写
    stageChapter(root, { 推进: '伏笔-040', 兑现: false, 证据命中: false })
    const { exitCode, stdout } = captureCli(() => checkCommand([root]))
    expect(exitCode).toBe('1')
    expect(stdout).toContain('声明')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
