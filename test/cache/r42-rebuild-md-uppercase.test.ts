/**
 * R42-38（四十二轮）回归：rebuild 摘要扫描的 .md 判定大小写不敏感。
 *
 * 修复前 scanSummaries 用 f.endsWith('.md') 过滤——win 资源管理器改出的 .MD/.Md
 * 摘要文件在目录过滤处即被静默丢弃（既不入库也不进健康报告，「摘要不生效」无从
 * 定位）。修复后过滤走 isMdFileName（大小写不敏感）、章号剥尾改 \.[mM][dD]$：
 * - 合法 <数字>.MD 入库（summaryCount 计入）；
 * - 白名单外命名（如 手写草稿.MD）不再被过滤吞掉，照常 errors/warn 留痕。
 */
import { describe, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeBareRoot(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r42-rebuild-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, book: { title: '书', genre: '玄幻' } })
  return root
}

describe('R42-38：.MD 大写扩展名摘要文件不再被静默过滤', () => {
  it('章摘要 <数字>.MD 入库；白名单外 .MD 进健康报告而非过滤丢弃', () => {
    const root = makeBareRoot()
    try {
      const chapterDir = join(root, '定稿', '摘要', '章摘要')
      mkdirSync(chapterDir, { recursive: true })
      writeFileSync(join(chapterDir, '5.MD'), '---\nchapter: 5\n---\n\n大写扩展名摘要\n', 'utf-8')
      writeFileSync(join(chapterDir, '9.md'), '合法小写摘要', 'utf-8')
      writeFileSync(join(chapterDir, '手写草稿.MD'), '白名单外的大写扩展名文件\n', 'utf-8')
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      // 5.MD 与 9.md 均入库（修复前 5.MD 被过滤，summaryCount=1）
      expect(r.summaryCount).toBe(2)
      // 手写草稿.MD 进入命名白名单判定 → errors 留痕（修复前被过滤吞掉，errors 空）
      const badErrors = r.errors.filter((e) => e.message.includes('手写草稿.MD'))
      expect(badErrors).toHaveLength(1)
      expect(badErrors[0]!.message).toContain('未入库')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('卷摘要 .Md/.mD 混合大小写同样入库且章号剥离正确', () => {
    const root = makeBareRoot()
    try {
      const volumeDir = join(root, '定稿', '摘要', '卷摘要')
      mkdirSync(volumeDir, { recursive: true })
      writeFileSync(join(volumeDir, '2.Md'), '第二卷摘要', 'utf-8')
      writeFileSync(join(volumeDir, '3.mD'), '第三卷摘要', 'utf-8')
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(2)
      // 章号提取不残留尾巴：'.Md' 剥尾后 '2' 为纯数字才入库——若剥尾仍大小写敏感，
      // '2.Md' 会进白名单外 errors 而非 summaryCount
      expect(r.errors.filter((e) => e.message.includes('摘要文件名'))).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
