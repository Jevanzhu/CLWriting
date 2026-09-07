/**
 * R59 清偿批（R55-B-3）回归：摘要目录非 .md 普通文件 log.warn 留痕。
 *
 * 原实现：scanSummaries 的文件过滤（isMdFileName + `._` 前缀豁免）把非 .md 普通文件
 * 静默跳过（不入库不留痕），与同函数白名单外 .md 命名（R73-47 log.warn+warnings）/
 * 误建子目录（R48-65 log.warn）两处留痕口径不一。修复后补 log.warn 同款留痕（命名
 * 契约不动，非 .md 仍不入摘要索引；`._` 前缀资源分叉文件保持豁免）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

describe('R55-B-3 / 摘要目录非 .md 普通文件 warn 留痕', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'r59-rebuild-nonmd-'))
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 摘要书\n', 'utf-8')
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '7.md'), '---\nchapter: 7\n---\n\n正常摘要\n', 'utf-8')
    writeFileSync(join(dir, 'notes.txt'), '散落的普通文件\n', 'utf-8')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('非 .md 普通文件：warn 留痕 + 不入库（.md 照常入库）', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(1) // 7.md 照常入库
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('notes.txt')
      expect(warned).toContain('非 .md 文件')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('`._` 前缀文件（macOS 资源分叉）保持豁免不告警', () => {
    writeFileSync(join(root, '定稿', '摘要', '章摘要', '._7.md'), '资源分叉\n', 'utf-8')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      rebuild(root, join(root, '.cache', 'index.db'))
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).not.toContain('._7.md')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
