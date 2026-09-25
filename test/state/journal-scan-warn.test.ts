/**
 * R54-B-1（五十四轮）回归：journal 崩溃恢复扫描异常 → warn 留痕（降级不阻断进门）。
 *
 * 修复前：外层 catch 空体零留痕——循环内任一意外异常（readdirSync EACCES 等）把整轮
 * 崩溃恢复检查静默归零，作者对上次崩溃丢字零感知且无诊断线索（对齐同函数其他降级
 * 分支的 warn 口径）。触发形态：`.journal` 在盘但非目录（ENOTDIR）——existsSync 过、
 * readdirSync 抛，确定性触发外层 catch（免权限注入，跨平台成立）。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBookWithChapters } from '../helpers/book.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

const FAST_CHAPTER_FIXTURE = { commitEach: false }

test('R54-B-1: journal 扫描异常 → warn 留痕，detectState 不阻断照常出态', async () => {
  const logMod = await import('../../src/log/index.js')
  const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
  const root = makeGitBookWithChapters(1, FAST_CHAPTER_FIXTURE)
  try {
    // 触发形态：.journal 路径被普通文件占位（existsSync 过、readdirSync ENOTDIR）
    rmSync(join(root, '工作区', '.journal'), { recursive: true, force: true })
    writeFileSync(join(root, '工作区', '.journal'), 'not-a-dir')
    // 修复点：warn 留痕点名降级（修复前静默归零零痕迹）
    await expect(detectState(root, DEFAULT_CONFIG)).resolves.toBeTruthy()
    expect(spy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('journal 扫描异常'))).toBe(true)
  } finally {
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('R54-B-1: 正常 journal 目录扫描零 warn（留痕不误报）', async () => {
  const logMod = await import('../../src/log/index.js')
  const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
  const root = makeGitBookWithChapters(1, FAST_CHAPTER_FIXTURE)
  try {
    await detectState(root, DEFAULT_CONFIG)
    expect(spy.mock.calls.some((c) => String(c[1] ?? c[0]).includes('journal 扫描异常'))).toBe(false)
  } finally {
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
