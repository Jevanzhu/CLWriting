/**
 * 自由模式手写定稿 e2e —— W2B B3。
 *
 * 验证：hand 建草稿 → 手写正文 → finalize 自由模式（跳审稿/机检闸，
 * 自动补 mode=hand 确认）→ ch: commit + Confirmed mode=hand trailer。
 * 对照：严格模式无审稿裁决 → 闸拦（证明 free 确实跳了审稿闸）。
 */

import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGitBook } from '../helpers/book.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { handCommand } from '../../src/cli/hand.js'
import { finalizeCommand } from '../../src/cli/finalize.js'

/** 造一本自由模式（workflow=free）长篇干净书（改 book.yaml 后 commit 保 git 干净） */
function makeGitBookFree(): string {
  const root = makeGitBook()
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, workflow: 'free' })
  execSync('git add -A && git commit -m "workflow free"', { cwd: root, stdio: 'pipe' })
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

test('B3 e2e: hand → 手写正文 → finalize 自由模式（跳审稿/机检，mode=hand trailer）', () => {
  const root = makeGitBookFree()
  try {
    // 1. hand 建草稿模板
    captureCli(() => handCommand([root]))
    const draftPath = join(root, '工作区', '草稿-1.md')
    expect(existsSync(draftPath)).toBe(true)

    // 2. 手写正文（覆盖草稿；只给章号/标题，钩子/情绪用 readChapter 默认）
    writeFileSync(
      draftPath,
      '---\n章号: 1\n标题: 开篇\n---\n\n这是手写的第一章正文。\n',
      'utf-8',
    )

    // 3. finalize（无细纲/无审稿/无 confirm —— 自由模式自动补 mode=hand + 跳闸）
    const { stdout, exitCode } = captureCli(() => finalizeCommand([draftPath, root]))
    expect(exitCode).toBeNull()
    expect(stdout).toContain('第 1 章已定稿')

    // 落 定稿/正文/1-开篇.md
    expect(existsSync(join(root, '定稿', '正文', '1-开篇.md'))).toBe(true)

    // commit msg ch:0001 开篇 + Confirmed trailer mode=hand
    const log = execSync('git log --format=%B', { cwd: root, encoding: 'utf-8' })
    expect(log).toMatch(/ch:0001 开篇/)
    expect(log).toMatch(/mode=hand/)

    // 工作区草稿已清空
    expect(existsSync(draftPath)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B3 对照: 严格模式无审稿裁决 → 审稿闸拦（证明 free 确实跳了审稿闸）', () => {
  const root = makeGitBook() // DEFAULT_CONFIG 无 workflow → getWorkflow=strict
  try {
    writeFileSync(
      join(root, '工作区', '草稿-1.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n',
      'utf-8',
    )
    // 无审稿裁决（strict 需 审稿.md approved）
    const { stdout, exitCode } = captureCli(() =>
      finalizeCommand([join(root, '工作区', '草稿-1.md'), root]),
    )
    expect(exitCode).toBe('1')
    expect(stdout).toContain('还没拍板') // 审稿裁决闸拦（free 跳过这道）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
