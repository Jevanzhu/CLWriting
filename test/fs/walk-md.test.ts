/**
 * L-P1（第八轮）回归：共享 walkMdFind——环剪枝 + 起遍目录根界。
 *
 * 修复背景：summary/materials/leads 三处手写递归找章无 visited（书内 a→b→a symlink
 * 环深递归，靠帧内 try/catch 兜 RangeError 整项退化）、无根界（书内指向书外的
 * symlink 被跟随，引文命中/摘要正文整读外部文件）。book-search.walkMd（第六轮）
 * 同族修复的横向收口。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkMdFind } from '../../src/fs/walk-md.js'
import { findChapterFile } from '../../src/process/summary.js'

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('L-P1: 书内 symlink 环（a→b→a）不无限递归，正常章仍可找到', () => {
  const root = mkdtempSync(join(tmpdir(), 'walk-md-cycle-'))
  try {
    const body = join(root, '写作', '正文')
    mkdirSync(join(body, 'a'), { recursive: true })
    mkdirSync(join(body, 'b'), { recursive: true })
    symlinkSync(join('..', 'b'), join(body, 'a', 'to-b'))
    symlinkSync(join('..', 'a'), join(body, 'b', 'to-a'))
    writeFileSync(join(body, 'a', '12-灭门.md'), 'x')

    const hit = walkMdFind(body, (abs, name) => (name.startsWith('12-') ? abs : undefined))
    expect(hit).toBe(realpathSync(join(body, 'a', '12-灭门.md')))

    // findChapterFile（summary 侧接线）同口径
    expect(findChapterFile(root, 12)).toBeTruthy()
    expect(findChapterFile(root, 13)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('L-P1: 书内指向书外的 symlink 不被跟随（根界 = 起遍目录）', () => {
  const root = mkdtempSync(join(tmpdir(), 'walk-md-escape-'))
  const outside = mkdtempSync(join(tmpdir(), 'walk-md-out-'))
  try {
    const body = join(root, '写作', '正文')
    mkdirSync(body, { recursive: true })
    writeFileSync(join(outside, '12-外泄.md'), 'x')
    symlinkSync(outside, join(body, 'outside-link'))
    // 书内正常章在后（遍历顺序不保证）——无论顺序，书外文件不可命中
    writeFileSync(join(body, '12-正文.md'), 'x')

    const hit = walkMdFind(body, (abs, name) => (name.startsWith('12-') ? abs : undefined))
    expect(hit).toBeTruthy()
    expect(hit).not.toContain(outside)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
