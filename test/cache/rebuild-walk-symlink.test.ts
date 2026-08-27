/**
 * N2（五十九轮）回归：rebuild 两套 walker 口径对齐（walkChapters / walkSourceStats
 * 统一 walk-md 共享核心——Dirent 不跟随 symlink + visited 剪枝 + 根界）。
 *
 * - 正文区 symlink 环 → 不 RangeError 崩 rebuild；
 * - 指向书外的 symlink 章不被整读入库（根界 fail-closed）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'

/** 最小长篇书骨架（有 布线/ → detectState/rebuild 走全量路径）。 */
function makeLongBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'n2-rebuild-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'book:\n  title: 测试书\n  genre: 悬疑\nleads:\n  enabled: []\n', 'utf-8')
  return root
}

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('N2: rebuild 正文区 symlink 环不崩，正常章照常入库', () => {
  const root = makeLongBook()
  writeFileSync(join(root, '写作', '正文', '0001-第一章.md'), '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n', 'utf-8')
  mkdirSync(join(root, '写作', '正文', 'b'), { recursive: true })
  symlinkSync(join(root, '写作', '正文', 'b'), join(root, '写作', '正文', 'a'))
  symlinkSync(join(root, '写作', '正文', 'a'), join(root, '写作', '正文', 'b', 'a'))
  // 旧实现 walkChapters 裸 statSync 跟随环 → RangeError；新口径剪枝正常入库
  const r = rebuild(root, join(root, '.cache', 'index.db'))
  expect(r.chapterCount).toBe(1)
  expect(r.errors).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('N2: rebuild 不跟随指向书外的 symlink 章（不入库、不抬计数）', () => {
  const root = makeLongBook()
  writeFileSync(join(root, '写作', '正文', '0001-第一章.md'), '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n', 'utf-8')
  const outside = mkdtempSync(join(tmpdir(), 'n2-rb-outside-'))
  writeFileSync(join(outside, '0002-外链.md'), '---\n章号: 2\n标题: 外链\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n书外内容。\n', 'utf-8')
  symlinkSync(join(outside, '0002-外链.md'), join(root, '写作', '正文', '0002-外链.md'))
  const r = rebuild(root, join(root, '.cache', 'index.db'))
  expect(r.chapterCount).toBe(1) // 书外 symlink 不整读入库
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
