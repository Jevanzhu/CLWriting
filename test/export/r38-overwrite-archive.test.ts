/**
 * R38-2/R38-17（三十八轮修复批）回归：导出链两处数据安全补口。
 *
 * R38-2：同名「全本-<书名>.md」/「投稿视图-*.md」再导出先归档再覆盖——原实现只归档
 * 「其它名字」，当前同名被 atomicWrite 直接覆盖，作者手改稿静默销毁（R65-27 分章侧
 * 同族哲学补齐）。
 * R38-17：readUnitBody 补非 UTF-8 防线——GBK 章此前 utf-8 文本直读产出 U+FFFD 乱码
 * 且零警告、照常计入 chapterCount；现记警告按读取失败同口径跳过。
 */
import { describe, expect, it } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-r38-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(
    join(root, '写作', '正文', `${num}-${title}.md`),
    `---\n章号: ${num}\n标题: ${title}\n---\n${body}`,
    'utf-8',
  )
}

const OLD_EXPORT_DIR = '.旧版'

describe('R38-2：同名产物先归档再覆盖', () => {
  it('merged：再导出时手改的同名全本被归档进 .旧版/ 而非静默覆盖', () => {
    const root = makeLongBook('同名归档')
    writeLongChapter(root, 1, '第一章', '原始正文。')
    try {
      const r1 = exportBook({ bookRoot: root, format: 'merged' })
      expect(r1.ok).toBe(true)
      const mergedPath = join(root, '工作区', '导出', '全本-同名归档.md')
      // 模拟作者手改导出稿
      writeFileSync(mergedPath, '# 手改内容（作者批注版）', 'utf-8')

      const r2 = exportBook({ bookRoot: root, format: 'merged' })
      expect(r2.ok).toBe(true)
      // 当前同名产物是重新导出的干净稿（含正文，非手改残留）
      expect(readFileSync(mergedPath, 'utf-8')).toContain('原始正文')
      // 手改版被归档保留（修复点：原实现直接覆盖销毁）
      const archived = join(root, '工作区', '导出', OLD_EXPORT_DIR)
      expect(readdirSync(archived)).toContain('全本-同名归档.md')
      expect(readFileSync(join(archived, '全本-同名归档.md'), 'utf-8')).toContain('手改内容')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merged：无同名产物时不产生空归档行为（首导出零 warnings）', () => {
    const root = makeLongBook('首导无档')
    writeLongChapter(root, 1, '第一章', '正文。')
    try {
      const r = exportBook({ bookRoot: root, format: 'merged' })
      expect(r.ok).toBe(true)
      expect(r.warnings ?? []).toEqual([])
      expect(existsSync(join(root, '工作区', '导出', OLD_EXPORT_DIR))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R38-17：非 UTF-8 定稿章导出记警告跳过', () => {
  it('GBK 正文章不再以 U+FFFD 乱码进入产物，warning 指引转码', () => {
    const root = makeLongBook('非utf8章')
    writeLongChapter(root, 1, '正常章', '正常正文。')
    // 混合编码形态：fm 为合法 UTF-8（meta 可解析、章进得了导出单元），正文段为
    // GBK 原始字节（外部工具追加/转码事故的真实形态）——修复前 utf-8 文本直读
    // 产出 U+FFFD 乱码正文且零警告
    const fmUtf8 = Buffer.from('---\n章号: 2\n标题: 乱码章\n---\n', 'utf-8')
    const gbkBody = Buffer.from([0xc7, 0xeb, 0xb4, 0xcb, 0xb4, 0xa6, 0xd5, 0xfd, 0xce, 0xc4]) // GBK 双字节序列
    writeFileSync(join(root, '写作', '正文', '2-乱码章.md'), Buffer.concat([fmUtf8, gbkBody]))
    try {
      const r = exportBook({ bookRoot: root, format: 'merged' })
      expect(r.ok).toBe(true)
      // GBK 章被跳过（不计入 chapterCount），产物只含正常章
      expect(r.chapterCount).toBe(1)
      const merged = readFileSync(join(root, '工作区', '导出', '全本-非utf8章.md'), 'utf-8')
      expect(merged).toContain('正常正文')
      expect(merged).not.toContain('\uFFFD')
      expect(merged).not.toContain('乱码章')
      // 警告可行动（指路转码）
      expect(r.warnings?.some((w) => w.includes('2-乱码章.md') && w.includes('UTF-8'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
