/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：fm `序`/`并入` 键解析矩阵。
 *
 * 覆盖：number / 数字串 / 小数串（拆分中值主流形态）/ 顿号分隔 / 内联数组 / 引号串 /
 * 非法值缺省（不报错）/ 旧书无键零迁移；`_raw.已发布` 保形与两键不入 _raw。
 * 归一小函数（parseOrderOf/parseMergedInto/isPublishedValue）另含纯函数直测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChapter, parseOrderOf, parseMergedInto, isPublishedValue } from '../../src/format/chapters.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-structure-fm-'))
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** 写一章并读回（fmRaw 逐字节注入，body 固定） */
const roundTrip = (fmRaw: string) => {
  const fp = join(dir, `0001-测试.md`)
  writeFileSync(fp, `---\n章号: 1\n标题: 测试\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n${fmRaw}---\n\n正文。\n`)
  const r = readChapter(fp)
  if (!r.ok) throw new Error(`readChapter 失败：${r.error.message}（fmRaw=${JSON.stringify(fmRaw)}）`)
  return r.chapter
}

// ── 序 解析矩阵 ─────────────────────────────────

describe('S2 fm 序 解析', () => {
  it('number 直取（`序: 12`）', () => {
    expect(roundTrip('序: 12\n').序).toBe(12)
  })

  it('小数串强转（`序: 12.5`——拆分中值主流形态，parseValue 只认纯整数落字符串）', () => {
    expect(roundTrip('序: 12.5\n').序).toBe(12.5)
  })

  it('数字串/带引号串/前后空白', () => {
    expect(roundTrip('序: "12.5"\n').序).toBe(12.5)
    expect(roundTrip('序:   7  \n').序).toBe(7)
    expect(roundTrip("序: '8'\n").序).toBe(8)
  })

  it('非法值按缺省（非数值/零/负数/空串不报错、不落字段）', () => {
    expect(roundTrip('序: 五\n').序).toBeUndefined()
    expect(roundTrip('序: -3\n').序).toBeUndefined()
    expect(roundTrip('序: 0\n').序).toBeUndefined()
    expect(roundTrip('序: ""\n').序).toBeUndefined()
    expect(roundTrip('序: 1e3\n').序).toBe(1000) // Number() 收敛的科学计数法合法
  })

  it('旧书无键零迁移（字段缺省）', () => {
    const ch = roundTrip('')
    expect(ch.序).toBeUndefined()
    expect(ch.并入).toBeUndefined()
  })
})

// ── 并入 解析矩阵 ───────────────────────────────

describe('S2 fm 并入 解析', () => {
  it('number 单值 → [n]', () => {
    expect(roundTrip('并入: 13\n').并入).toEqual([13])
  })

  it('字符串逗号分隔（`并入: 12, 13`）', () => {
    expect(roundTrip('并入: 12, 13\n').并入).toEqual([12, 13])
  })

  it('顿号分隔（`并入: 12、13`）', () => {
    expect(roundTrip('并入: 12、13\n').并入).toEqual([12, 13])
  })

  it('全角逗号分隔', () => {
    expect(roundTrip('并入: 12，13\n').并入).toEqual([12, 13])
  })

  it('内联数组（`并入: [12, 13]`——规范写形态）', () => {
    expect(roundTrip('并入: [12, 13]\n').并入).toEqual([12, 13])
  })

  it('带引号串（`并入: "12,13"`）', () => {
    expect(roundTrip('并入: "12,13"\n').并入).toEqual([12, 13])
  })

  it('非法项丢弃（小数/汉字/零/负数），合法项保留；全非法 → 缺省', () => {
    expect(roundTrip('并入: 12, 13.5, 五, 0, -1\n').并入).toEqual([12])
    expect(roundTrip('并入: 五, 1.5\n').并入).toBeUndefined()
    expect(roundTrip('并入: []\n').并入).toBeUndefined()
  })

  it('重复项去重（`并入: 12, 12`）', () => {
    expect(roundTrip('并入: 12, 12\n').并入).toEqual([12])
  })
})

// ── _raw 保形与键集 ─────────────────────────────

describe('S2 KNOWN_FM_KEYS 扩键后的 _raw 行为', () => {
  it('序/并入 入已知键集后不再落 _raw；`已发布` 仍留 _raw（S3 fm 重组保形前提）', () => {
    const ch = roundTrip('序: 2.5\n并入: 13\n已发布: true\n')
    expect(ch._raw).toBeDefined()
    expect(Object.keys(ch._raw!)).toEqual(['已发布'])
    expect(ch._raw!['已发布']).toBe('true')
  })

  it('无未知键时 _raw 缺省（既有行为不变）', () => {
    const ch = roundTrip('序: 2.5\n并入: 13\n')
    expect(ch._raw).toBeUndefined()
  })
})

// ── 归一小函数直测 ──────────────────────────────

describe('S2 parseOrderOf / parseMergedInto / isPublishedValue 纯函数', () => {
  it('parseOrderOf：probe 原始捕获串（成对引号内剥）与 parseFlat 值同口径', () => {
    expect(parseOrderOf(12)).toBe(12)
    expect(parseOrderOf(' 12.5 ')).toBe(12.5)
    expect(parseOrderOf('"12.5"')).toBe(12.5)
    expect(parseOrderOf("'3'")).toBe(3)
    expect(parseOrderOf('五')).toBeUndefined()
    expect(parseOrderOf('')).toBeUndefined()
    expect(parseOrderOf(null)).toBeUndefined()
    expect(parseOrderOf(true)).toBeUndefined()
  })

  it('parseMergedInto：三形态归一 + 非法缺省', () => {
    expect(parseMergedInto(13)).toEqual([13])
    expect(parseMergedInto('13, 14、15')).toEqual([13, 14, 15])
    expect(parseMergedInto(['12', '13'])).toEqual([12, 13])
    expect(parseMergedInto('五')).toBeUndefined()
    expect(parseMergedInto([null, 'x'])).toBeUndefined()
    expect(parseMergedInto(undefined)).toBeUndefined()
  })

  it('isPublishedValue：仅认 true/\'true\'（树 probe 与导出 _raw 同式）', () => {
    expect(isPublishedValue(true)).toBe(true)
    expect(isPublishedValue('true')).toBe(true)
    expect(isPublishedValue(['true'])).toBe(true)
    expect(isPublishedValue('是')).toBe(false)
    expect(isPublishedValue('1')).toBe(false)
    expect(isPublishedValue(false)).toBe(false)
    expect(isPublishedValue(undefined)).toBe(false)
  })
})
