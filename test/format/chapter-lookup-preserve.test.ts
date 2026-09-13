/**
 * 阶段 24 章节结构操作批 B / S3：结构键（fm 序/并入）保形 helper 单元直测
 * （format/chapter-lookup.ts 尾部 preserveStructureFmIn / preserveStructureFmForChapter）。
 *
 * 覆盖：盘上有键 incoming 缺 → 键级回补（序 = 盘上值非默认，其余 fm 行与正文逐段
 * 不变，仅追加键行）；incoming 已含键不覆写（显式产出优先）；盘上无 fm / incoming
 * 裸 md / 文件不存在 / 盘上无结构键 → 原样返回不抛（保形是防丢键兜底，不拒绝写盘）；
 * 按章号定位转调（chapterPathByNumber 命中生效 + miss 容错）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveStructureFmIn, preserveStructureFmForChapter } from '../../src/format/chapter-lookup.js'
import { splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-chapter-lookup-preserve-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 断言前置：取内容 fm 的平铺键值（须有 fm） */
const fmOf = (content: string): Map<string, unknown> => {
  const split = splitFrontMatter(content)
  if (split === null) throw new Error('断言前置：内容应有 front matter')
  return parseFlat(split.fmRaw)
}

/** 盘上目标章（fm 含 序: 7 与 并入: [5]——合并目标章的典型结构键形态） */
const writeDiskChapter = (): string => {
  const abs = join(root, '0002-目标.md')
  writeFileSync(
    abs,
    '---\n章号: 2\n标题: 目标\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n序: 7\n并入: [5]\n---\n目标章正文。\n',
  )
  return abs
}

describe('S3 preserveStructureFmIn：盘上 序/并入 键级保形', () => {
  it('盘上含 序: 7 与 并入: [5]、incoming 缺两键 → 回补两键（序 = 盘上 7 非默认），其余 fm 行与正文逐段不变（仅追加键行）', () => {
    const abs = writeDiskChapter()
    const incoming = '---\n章号: 2\n标题: 新稿\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n新稿正文。\n'
    const out = preserveStructureFmIn(abs, incoming)
    // patchFlatFm 追加语义：未命中键行追加在 fm 末尾（序 先于 并入），其余行原序保留
    expect(out).toBe(
      '---\n章号: 2\n标题: 新稿\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n序: 7\n并入: [5]\n---\n新稿正文。\n',
    )
    const fm = fmOf(out)
    expect(fm.get('序')).toBe(7)
    // parseFlat 内联数组项为 string（parseMergedInto 才归一 number[]）——此处锁盘上文本形态
    expect(fm.get('并入')).toEqual(['5'])
  })

  it('incoming 已含 序: 9（与盘上 7 不同）→ 保持 9 不覆写；并入 盘上有 incoming 无 → 仍回补 [5]', () => {
    const abs = writeDiskChapter()
    const incoming = '---\n章号: 2\n标题: 新稿\n序: 9\n---\n新稿正文。\n'
    const out = preserveStructureFmIn(abs, incoming)
    expect(out).toBe('---\n章号: 2\n标题: 新稿\n序: 9\n并入: [5]\n---\n新稿正文。\n')
    const fm = fmOf(out)
    expect(fm.get('序')).toBe(9)
    expect(fm.get('并入')).toEqual(['5'])
  })

  it('盘上文件无 fm（裸正文）→ 原样返回（不注入任何键、不加 fence）', () => {
    const abs = join(root, '0002-裸.md')
    writeFileSync(abs, '裸正文，没有 front matter。\n第二行。\n')
    const incoming = '---\n章号: 2\n标题: 新稿\n---\n新稿正文。\n'
    expect(preserveStructureFmIn(abs, incoming)).toBe(incoming)
  })

  it('incoming 无 fm（裸 md 产出）→ 原样返回（保形只作用于带 fm 的强覆盖内容）', () => {
    const abs = writeDiskChapter()
    const incoming = 'AI 自由文本产出，无 front matter。\n'
    expect(preserveStructureFmIn(abs, incoming)).toBe(incoming)
  })

  it('盘上文件不存在 / 父目录不存在 → 原样返回不抛', () => {
    const incoming = '---\n章号: 2\n标题: 新稿\n---\n新稿正文。\n'
    expect(preserveStructureFmIn(join(root, '不存在-0002.md'), incoming)).toBe(incoming)
    expect(preserveStructureFmIn(join(root, '不存在的目录', '0002-目标.md'), incoming)).toBe(incoming)
  })

  it('盘上无结构键（updates 空）→ 零改动原样返回（不重排 fm、不加 fence 副作用）', () => {
    const abs = join(root, '0002-普通.md')
    const content = '---\n章号: 2\n标题: 普通\n---\n正文。\n'
    writeFileSync(abs, content)
    expect(preserveStructureFmIn(abs, content)).toBe(content)
  })
})

describe('S3 preserveStructureFmForChapter：按章号定位转调', () => {
  it('写作/正文/第一卷/0003-第3章.md 在盘（fm 含 序）→ chapter=3 定位回补盘上值', () => {
    const abs = join(root, '写作', '正文', '第一卷', '0003-第3章.md')
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '---\n章号: 3\n标题: 第3章\n序: 7\n并入: [5]\n---\n第3章正文。\n')
    const incoming = '---\n章号: 3\n标题: 第3章新稿\n---\n新稿正文。\n'
    const out = preserveStructureFmForChapter(root, 3, incoming)
    expect(out).toBe('---\n章号: 3\n标题: 第3章新稿\n序: 7\n并入: [5]\n---\n新稿正文。\n')
  })

  it('chapter 无对应文件（按名与并入映射均 miss）→ 原样返回不抛', () => {
    const incoming = '---\n章号: 9\n标题: 新稿\n---\n新稿正文。\n'
    expect(preserveStructureFmForChapter(root, 9, incoming)).toBe(incoming)
  })
})
