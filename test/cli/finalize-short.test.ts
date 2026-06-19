/**
 * 短篇 finalize CLI 门面测试 —— M8 第二批 #27。
 *
 * 验收致命坑修复：finalize CLI 读 config.kind 传给 doFinalize；
 * 短篇落 篇/<篇号>-<标题>/正文.md + commit pc: 前缀；文案出「篇」。
 */

import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeChapter } from '../../src/format/chapters.js'
import { writePiece } from '../../src/format/pieces.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { REVIEW_VERDICT_MARKER } from '../../src/review/run.js'
import { finalizeCommand } from '../../src/cli/finalize.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-定稿短篇-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 捕获 console + process.exit（命令处理器内调 process.exit） */
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

test('finalize CLI short: 落 篇/ + pc: 前缀 + 文案出「篇」', () => {
  const root = makeShortBook()
  try {
    // 工作区放草稿（短篇用 篇号，writePiece；readDraft 短篇分支读篇号）
    writePiece(join(root, '工作区', '草稿-1.md'), { 篇号: 1, 标题: '雪夜来客' }, '他推开门，血溅了一地。')
    writeFileSync(join(root, '工作区', '细纲.md'), '细纲内容', 'utf-8')
    // 确认细纲（前置闸刚需）
    doConfirm(join(root, '工作区'), 1, join(root, '工作区', '细纲.md'), 'manual', SHORT_CONFIG)
    // 审稿裁决通过（前置闸刚需）
    writeFileSync(
      join(root, '工作区', '审稿.md'),
      `${REVIEW_VERDICT_MARKER} verdict: 通过\n`,
      'utf-8',
    )

    const { stdout, exitCode } = captureCli(() => finalizeCommand([root]))
    expect(exitCode).toBeNull()
    expect(stdout).toContain('第 1 篇已定稿')
    // 正文落 篇/001-雪夜来客/正文.md
    expect(existsSync(join(root, '篇', '001-雪夜来客', '正文.md'))).toBe(true)
    // commit msg 前缀 pc:001
    const log = execSync('git log --format=%s', { cwd: root, encoding: 'utf-8' }).trim().split('\n')
    expect(log.some((m) => /^pc:001 /.test(m))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finalize CLI short: 无裁决 → 前置闸拦', () => {
  const root = makeShortBook()
  try {
    writePiece(join(root, '工作区', '草稿-1.md'), { 篇号: 1, 标题: '雪夜' }, '正文')
    writeFileSync(join(root, '工作区', '细纲.md'), '细纲', 'utf-8')
    doConfirm(join(root, '工作区'), 1, join(root, '工作区', '细纲.md'), 'manual', SHORT_CONFIG)
    // 无审稿裁决（不写 审稿.md approved）

    const { exitCode, stdout } = captureCli(() => finalizeCommand([root]))
    expect(exitCode).toBe('1')
    expect(stdout).toContain('还没拍板')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
