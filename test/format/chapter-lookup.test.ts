/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：章号回退 helper 单源（format/chapter-lookup.ts）。
 *
 * 覆盖：正文命中优先（不咨询 Map）/ 折叠链单跳 / Map miss 返 null / 回收站还原后
 * 正文命中优先于陈旧并入 / 跨卷重号 warn（foreshadow.ts 先例对齐：warn 不炸、后扫覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergedIntoMap, chapterTextByNumber, chapterPathByNumber } from '../../src/format/chapter-lookup.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-chapter-lookup-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 写一章（fm 可注入 序/并入） */
const writeCh = (rel: string, chapter: number, title: string, body: string, fmExtra = '') => {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(
    abs,
    `---\n章号: ${chapter}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n${fmExtra}---\n${body}\n`,
  )
  return abs
}

/** walkMdFind 产 realpath（mac /var → /private/var），与 root 拼接路径对齐后比较 */
const samePath = (a: string | null, b: string): boolean => a !== null && realpathSync(a) === realpathSync(b)

describe('S2 mergedIntoMap：并入映射构建', () => {
  it('目标章 并入 数组逐项登记（源章号 → 目标章路径）；无 并入 章不登记', () => {
    const t = writeCh('写作/正文/0002-目标.md', 2, '目标', '目标正文', '并入: [3, 4]\n')
    writeCh('写作/正文/0001-普通.md', 1, '普通', '普通正文')
    const map = mergedIntoMap(root)
    expect(map.size).toBe(2)
    expect(map.get(3)).toBe(t)
    expect(map.get(4)).toBe(t)
  })

  it('折叠链单跳（11 并 12,13 → 源 12/13 直接重指向 11，读侧无递归）', () => {
    const t = writeCh('写作/正文/0011-大章.md', 11, '大章', '大正文', '并入: [12, 13]\n')
    const map = mergedIntoMap(root)
    expect(map.get(12)).toBe(t)
    expect(map.get(13)).toBe(t)
  })

  it('跨卷重号：两章都声明吸收同一源章 → warn 不炸、后扫覆盖其一', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const a = writeCh('写作/正文/卷一/0004-A.md', 4, 'A', 'A 正文', '并入: 5\n')
    const b = writeCh('写作/正文/卷二/0006-B.md', 6, 'B', 'B 正文', '并入: 5\n')
    const map = mergedIntoMap(root)
    expect(map.size).toBe(1)
    expect([a, b]).toContain(map.get(5))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![1]).toContain('并入映射冲突')
  })

  it('无正文目录 → 空 Map（容错）', () => {
    expect(mergedIntoMap(root).size).toBe(0)
  })
})

describe('S2 chapterTextByNumber / chapterPathByNumber：回退语义', () => {
  it('正文命中优先（不咨询 Map）——源章文件在时按名即中', () => {
    const target = writeCh('写作/正文/0002-目标.md', 2, '目标', '合并后的正文', '并入: 3\n')
    const src = writeCh('写作/正文/0003-源.md', 3, '源', '源章自己的正文')
    // 按名命中源章（不回退）——「并入所指章存活」属 S5 repair 面违反态，读取侧正文优先
    expect(samePath(chapterPathByNumber(root, 3), src)).toBe(true)
    expect(chapterTextByNumber(root, 3)?.trim()).toBe('源章自己的正文')
    expect(samePath(chapterPathByNumber(root, 2), target)).toBe(true)
  })

  it('按名 miss → 并入回退目标章正文（合并后源章号仍可读）', () => {
    writeCh('写作/正文/0002-目标.md', 2, '目标', '目标正文前半\n源章并入的后半', '并入: 3\n')
    expect(chapterTextByNumber(root, 3)?.trim()).toBe('目标正文前半\n源章并入的后半')
    expect(chapterTextByNumber(root, 2)?.trim()).toBe('目标正文前半\n源章并入的后半')
  })

  it('折叠链单跳读取（11 并 12,13：读 13 直达 11 正文）', () => {
    writeCh('写作/正文/0011-大章.md', 11, '大章', '十一年前的旧案', '并入: [12, 13]\n')
    expect(chapterTextByNumber(root, 13)?.trim()).toBe('十一年前的旧案')
    expect(chapterTextByNumber(root, 12)?.trim()).toBe('十一年前的旧案')
  })

  it('Map miss（章号既不在正文也无并入去向）→ null（调用方容错）', () => {
    writeCh('写作/正文/0002-目标.md', 2, '目标', '正文', '并入: 3\n')
    expect(chapterTextByNumber(root, 9)).toBeNull()
    expect(chapterPathByNumber(root, 9)).toBeNull()
  })

  it('回收站还原后正文命中优先于陈旧并入（通用还原的惰性无害语义）', () => {
    // 合并态：12 并入 11；随后源章 12 经通用还原回正文（并入 残留未摘）
    writeCh('写作/正文/0011-目标.md', 11, '目标', '合并后的正文', '并入: 12\n')
    const restored = writeCh('写作/正文/0012-还原.md', 12, '还原', '还原回来的源章正文')
    expect(samePath(chapterPathByNumber(root, 12), restored)).toBe(true)
    expect(chapterTextByNumber(root, 12)?.trim()).toBe('还原回来的源章正文')
  })

  it('跨卷目标章回退（源章与目标章不同卷目录）', () => {
    const t = writeCh('写作/正文/卷二/0007-目标.md', 7, '目标', '卷二目标正文', '并入: 6\n')
    // 源章 6 原在卷一，已被合并摘除
    expect(samePath(chapterPathByNumber(root, 6), t)).toBe(true)
    expect(chapterTextByNumber(root, 6)?.trim()).toBe('卷二目标正文')
  })
})
