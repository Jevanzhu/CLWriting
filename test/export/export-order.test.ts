/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：导出排序键 + D7 章号呈现分流。
 *
 * 覆盖：sortKey 排序（序 ?? 章号）/ D7 分流（已发布固定本地章号、未发布段从
 * 「已发布最大章号+1」连续编）/ 留洞闭合（无 并入 章号空洞在分章前缀上闭合）/
 * 全本保留序（合并稿内容按 sortKey 序）/ chapterFilePrefix 单源收编（4 位前缀）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { scaffoldBook } from '../helpers/book.js'

let root = ''

beforeEach(() => {
  root = scaffoldBook({ name: '导出排序', dirs: ['写作/正文'] }).root
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 写一章（可带 fm 扩展键）并登记定稿基线 */
const addChapter = (no: number, title: string, body: string, fmExtra = '') => {
  const rel = `写作/正文/${String(no).padStart(4, '0')}-${title}.md`
  const abs = join(root, rel)
  writeFileSync(
    abs,
    `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n${fmExtra}---\n\n${body}\n`,
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, {
    id: generateDocId(),
    nodeType: 'document',
    path: rel,
    parentId: null,
    finalizedRevision: computeRevision(abs),
    finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)
}

const splitDirNames = (): string[] => readdirSync(join(root, '工作区', '导出', '分章')).sort()

describe('S2 导出排序与 D7 分流', () => {
  it('sortKey 排序：`序: 2.5`（拆分新章中值）在分章产物中插到 1 与 2 之间', () => {
    addChapter(1, '甲', '第一章内容')
    addChapter(2, '乙', '第二章内容')
    addChapter(5, '新章', '拆出来的新章内容', '序: 1.5\n')
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(splitDirNames()).toEqual(['0001-甲.md', '0002-新章.md', '0003-乙.md'])
  })

  it('留洞闭合：无 并入 的章号空洞（1,2,4）在未发布段连续编下闭合为 0003', () => {
    addChapter(1, '甲', '一')
    addChapter(2, '乙', '二')
    addChapter(4, '丁', '四')
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(splitDirNames()).toEqual(['0001-甲.md', '0002-乙.md', '0003-丁.md'])
  })

  it('D7 分流：已发布章固定本地章号，其后未发布段从「已发布最大章号+1」按序位连续编', () => {
    addChapter(1, '甲', '一', '已发布: true\n')
    addChapter(2, '乙', '二', '已发布: true\n')
    addChapter(3, '丙', '三', '已发布: true\n')
    // 未发布段：4 原位；6 序 4.5 提前；5 序 5.5 殿后 → 呈现序 4,6,5 → 编号 4,5,6
    addChapter(4, '丁', '四')
    addChapter(6, '己', '六', '序: 4.5\n')
    addChapter(5, '戊', '五', '序: 5.5\n')
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(splitDirNames()).toEqual([
      '0001-甲.md',
      '0002-乙.md',
      '0003-丙.md',
      '0004-丁.md',
      '0005-己.md',
      '0006-戊.md',
    ])
  })

  it('全零已发布旧书：连续编 ≡ 本地章号（旧书零迁移——无 序 无空洞零漂移）', () => {
    addChapter(1, '甲', '一')
    addChapter(2, '乙', '二')
    addChapter(3, '丙', '三')
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(splitDirNames()).toEqual(['0001-甲.md', '0002-乙.md', '0003-丙.md'])
  })

  it('全本合并稿：内容按 sortKey 序拼接（本地章号语义不受影响——全本无章号呈现）', () => {
    addChapter(1, '甲', '第一章的正文')
    addChapter(3, '丙', '第三章的正文', '序: 1.5\n')
    addChapter(2, '乙', '第二章的正文')
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    // scaffoldBook 不写 book.yaml → bookTitle 回落「未命名」
    const merged = join(root, '工作区', '导出', '全本-未命名.md')
    expect(existsSync(merged)).toBe(true)
    const content = readFileSync(merged, 'utf-8')
    const i1 = content.indexOf('# 甲')
    const i3 = content.indexOf('# 丙')
    const i2 = content.indexOf('# 乙')
    expect(i1).toBeGreaterThan(-1)
    expect(i3).toBeGreaterThan(i1) // 序 1.5 → 丙在甲后
    expect(i2).toBeGreaterThan(i3) // 乙按章号 2 殿后
  })

  it('chapterFilePrefix 单源收编：分章前缀 4 位补零与写侧同源（已发布章 displayNum = 本地章号）', () => {
    addChapter(3, '三章', '三', '已发布: true\n')
    addChapter(12, '十二章', '十二', '已发布: true\n')
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(splitDirNames()).toEqual(['0003-三章.md', '0012-十二章.md'])
  })
})
