/**
 * R73-47（二十一轮）回归：rebuild 扫描摘要遇白名单外命名（非 <数字>.md）log.warn 留痕。
 *
 * R71-37 起白名单外命名已计入 errors（meta 健康报告），但操作日志无痕——增量跳过重建
 * 时健康报告不可见，「摘要不生效」难定位。修复后 warn 即时留痕；命名契约本身不动
 * （白名单外仍不入库）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { log } from '../../src/log/index.js'

describe('R73-47 / 白名单外摘要命名 warn 留痕', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-rebuild-'))
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 摘要书\n', 'utf-8')
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '12.md'), '---\nchapter: 12\n---\n\n正常摘要\n', 'utf-8')
    writeFileSync(join(dir, '手写草稿.md'), '不是摘要命名约定的文件\n', 'utf-8')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('白名单外命名：warn 留痕 + 计入健康报告 + 不入库（白名单内照常入库）', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(1) // 12.md 入库
      expect(r.errors.some((e) => e.message.includes('手写草稿.md'))).toBe(true) // 健康报告在册
      expect(warnSpy).toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('手写草稿.md')
      expect(warned).toContain('未入库')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
