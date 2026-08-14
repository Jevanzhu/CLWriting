/**
 * git/exec.ts 存活面测试（去 git 清理后）。
 *
 * exec.ts 已删 addCommit / findChapterCommit / gitHealthCheck / lastCommitMsg
 * （零生产调用方的死代码）；仍存活：git() / statusPorcelain（migrate 反推用）/
 * scanCloudCopies（状态机进门检查）。本文件覆盖后两者的行为契约。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCloudCopies, statusPorcelain } from '../../src/git/exec.js'
import { makeGitBook } from '../helpers/book.js'

test('scanCloudCopies: Dropbox/OneDrive 风格「名 2.md」与 Google Drive「名 (1).md」命中', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第1章 2.md'), '副本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 (1).md'), '副本', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('2.md'))).toBe(true)
    expect(copies.some((f) => f.includes('(1).md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanCloudCopies: AppleDouble ._ 与 conflicted copy 命中；正常文件不命中', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', '._悬念-031.md'), 'AppleDouble', 'utf-8')
  writeFileSync(join(root, '布线', '悬念', '悬念-031-conflicted copy-2026.md'), '冲突副本', 'utf-8')
  writeFileSync(join(root, '布线', '悬念', '悬念-031.md'), '正常文件', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('._悬念'))).toBe(true)
    expect(copies.some((f) => f.includes('conflicted'))).toBe(true)
    expect(copies.includes(join(root, '布线', '悬念', '悬念-031.md'))).toBe(false) // 精确路径不误伤（._悬念-031.md 后缀相同但路径不同）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanCloudCopies: .git / node_modules / .cache 内部不扫', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  for (const d of ['.git', 'node_modules', '.cache']) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, '._index.db'), 'x', 'utf-8')
  }
  try {
    expect(scanCloudCopies(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statusPorcelain: 中文路径原样输出（core.quotepath=false）+ 行首状态码保留', () => {
  const root = makeGitBook()
  try {
    writeFileSync(join(root, '布线', '悬念', '悬念-999-测试.md'), '---\n---\n内容', 'utf-8')
    const out = statusPorcelain(root)
    expect(out).toContain('悬念-999-测试.md') // 不被八进制转义
    expect(out).not.toContain('\\351') // 未启用 quotepath=false 时的转义形态
    // 行首格式：XY<空格>path（untracked 为 "?? "）
    expect(out.split('\n').some((l) => l.startsWith('?? ') && l.includes('悬念-999'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
