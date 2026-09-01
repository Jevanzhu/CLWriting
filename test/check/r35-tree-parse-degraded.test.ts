/**
 * R35-24（三十五轮）回归：树红点聚合消费 readChapterDir 的解析错误。
 *
 * 缺陷：collectTreeIssues 只取 .chapters——章号损坏/缺章号的章进不了章列表，树视图
 * 对其完全隐形且无任何降级标志（损坏越重越安静）。修复后 errors 逐条 warn 留痕并以
 * chaptersParseDegraded 计数透出（与 chaptersDegraded 同款降级口径）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeIssues } from '../../src/check/run.js'
import { log } from '../../src/log/index.js'

/** 造最小草稿书（无布线：不涉 db 路径，只验章目录扫描聚合面）。 */
function makeDraftBook(corruptChapterNo: boolean): string {
  const root = mkdtempTracked(join(tmpdir(), 'r35-tree-parse-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\n', 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第1章的叙述文本。\n',
    'utf-8',
  )
  if (corruptChapterNo) {
    // 章号损坏（非整数）：readChapter 报错进 errors、不进 chapters——修复前树聚合静默丢弃
    writeFileSync(
      join(root, '写作', '正文', '002-第2章.md'),
      '---\n章号: 五\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第2章的叙述文本。\n',
      'utf-8',
    )
  }
  return root
}

describe('R35-24 / 树红点聚合的章目录解析降级可见性', () => {
  it('损坏章号目录 → chaptersParseDegraded 计数透出 + warn 留痕（修复前完全静默）', () => {
    const root = makeDraftBook(true)
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const r = collectTreeIssues(root, () => undefined)
      expect(r.chaptersParseDegraded).toBe(1)
      expect(r.rebuildFailed).toBe(false)
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('章文件解析失败')
      expect(warned).toContain('002-第2章.md')
    } finally {
      warnSpy.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('健康章目录 → chaptersParseDegraded === 0（口径复位）', () => {
    const root = makeDraftBook(false)
    try {
      const r = collectTreeIssues(root, () => undefined)
      expect(r.chaptersParseDegraded).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
