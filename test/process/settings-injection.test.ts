/**
 * C3（DSH-17）：设定注入字节预算——纯函数组装。
 *
 * 三条思想逐条验证：
 * - ① maxChars 非正/非有限 → 显式不注入（空串）；
 * - ② 超限先丢宽泛层（project 先于 volume 先于 chapter），丢到只剩最具体层仍超 → 截断；
 * - ③ in-band 声明计入预算：被丢/被截都留声明行，且总量恒 ≤ 预算。
 * 层序保持传入序，不按 specificity 重排。
 */
import { test, expect } from 'vitest'
import { assembleSettingsInjection, type SettingsLayer } from '../../src/process/settings-injection.js'
import { PRUNE_MARKER } from '../../src/process/prune.js'

/** 造指定 code point 长度的中文文本（带锚点字符，断言层去留用） */
function cn(anchor: string, len: number): string {
  return anchor.repeat(len)
}

const cpLen = (s: string): number => Array.from(s).length

/** 三档层样板：project(世界观) + volume(角色) + chapter(章内设定) */
function sampleLayers(): SettingsLayer[] {
  return [
    { name: '世界观', specificity: 'project', text: cn('世', 300) },
    { name: '角色设定', specificity: 'volume', text: cn('角', 200) },
    { name: '本章设定', specificity: 'chapter', text: cn('章', 100) },
  ]
}

test('预算守卫：0/-1/NaN/Infinity → 空串显式不注入（①）', () => {
  const layers = sampleLayers()
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = assembleSettingsInjection(layers, { maxChars: bad })
    expect(r.text).toBe('')
    expect(r.omitted).toEqual([])
    expect(r.truncated).toEqual([])
  }
})

test('空层数组 → 空串空数组（总量 0 ≤ 预算）', () => {
  const r = assembleSettingsInjection([], { maxChars: 100 })
  expect(r).toEqual({ text: '', omitted: [], truncated: [] })
})

test('恰等于预算 → 全量放行（无省略无截断）', () => {
  const layers = sampleLayers()
  // 总量 = 300+200+100 + 两道 '\n\n' 分隔 = 604
  const total = cpLen(layers.map((l) => l.text).join('\n\n'))
  expect(total).toBe(604)
  const r = assembleSettingsInjection(layers, { maxChars: total })
  expect(r.text).toBe(layers.map((l) => l.text).join('\n\n'))
  expect(r.omitted).toEqual([])
  expect(r.truncated).toEqual([])
})

test('超限 → project 层先整层丢 + 省略声明计价（②③）', () => {
  const layers = sampleLayers()
  // 预算 400：全量 604 超；丢世界观(300) 后 = 声明行(~16) + 200 + 100 + 分隔 ≈ 320 ≤ 400
  const r = assembleSettingsInjection(layers, { maxChars: 400 })
  expect(r.omitted).toEqual(['世界观'])
  expect(r.truncated).toEqual([])
  // in-band 声明指名丢了什么，且计入预算（总量 ≤ 400）
  expect(r.text).toContain('（设定超预算，已省略：世界观）')
  // 注意：声明行本身含层名「世界观」，断言的是正文大块消失而非单字
  expect(r.text).not.toContain(cn('世', 2))
  expect(r.text).toContain(cn('角', 200))
  expect(r.text).toContain(cn('章', 100))
  expect(cpLen(r.text)).toBeLessThanOrEqual(400)
})

test('丢一层即达标 → 不多丢（volume/chapter 原样保留）', () => {
  const layers = sampleLayers()
  // 预算 603（全量 604 差 1）：丢 project 一层即达标，volume/chapter 不动
  const r = assembleSettingsInjection(layers, { maxChars: 603 })
  expect(r.omitted).toEqual(['世界观'])
  expect(r.truncated).toEqual([])
  expect(r.text).toContain(cn('角', 200))
  expect(r.text).toContain(cn('章', 100))
  expect(cpLen(r.text)).toBeLessThanOrEqual(603)
})

test('丢到只剩最具体层仍超 → 截断该层 + 截断声明（②③）', () => {
  const layers: SettingsLayer[] = [
    { name: '世界观', specificity: 'project', text: cn('世', 500) },
    { name: '角色设定', specificity: 'volume', text: cn('角', 300) },
    { name: '本章设定', specificity: 'chapter', text: cn('章', 400) },
  ]
  // 预算 200：丢世界观(500)、丢角色(300) 后剩 本章设定(400)+两行声明 仍 > 200 → 截断
  const r = assembleSettingsInjection(layers, { maxChars: 200 })
  expect(r.omitted).toEqual(['世界观', '角色设定'])
  expect(r.truncated).toEqual(['本章设定'])
  expect(r.text).toContain('（设定超预算，已省略：世界观）')
  expect(r.text).toContain('（设定超预算，已省略：角色设定）')
  expect(r.text).toContain('（本章设定超预算已截断）')
  // 截断走 pruneTextMiddle：头尾保留 + 中段 marker 恰好一次
  expect(r.text.split(PRUNE_MARKER).length - 1).toBe(1)
  expect(r.text).toContain(cn('章', 10)) // 头部存活
  expect(r.text).not.toContain(cn('章', 300)) // 中段确实没了
  expect(cpLen(r.text)).toBeLessThanOrEqual(200)
})

test('单层即超预算 → 直接截断该层（无层可丢）', () => {
  const layers: SettingsLayer[] = [{ name: '本章设定', specificity: 'chapter', text: cn('章', 1000) }]
  const r = assembleSettingsInjection(layers, { maxChars: 100 })
  expect(r.omitted).toEqual([])
  expect(r.truncated).toEqual(['本章设定'])
  expect(r.text).toContain('（本章设定超预算已截断）')
  expect(r.text.split(PRUNE_MARKER).length - 1).toBe(1)
  expect(cpLen(r.text)).toBeLessThanOrEqual(100)
})

test('层序保持传入序——chapter 在前也不重排（调用方负责排列）', () => {
  const layers: SettingsLayer[] = [
    { name: '本章设定', specificity: 'chapter', text: '甲'.repeat(3) },
    { name: '世界观', specificity: 'project', text: '乙'.repeat(30) },
    { name: '角色设定', specificity: 'volume', text: '丙'.repeat(3) },
  ]
  // 预算内全量：输出序 = 传入序（甲→乙→丙），不按 specificity 排
  const full = assembleSettingsInjection(layers, { maxChars: 100 })
  expect(full.text).toBe(`${'甲'.repeat(3)}\n\n${'乙'.repeat(30)}\n\n${'丙'.repeat(3)}`)
  // 超限丢层同理：project(乙) 被丢，剩余层仍按传入序（甲在前）
  // 全量 = 3+30+3+4 = 40；丢乙后 = 3+2+15(声明)+2+3 = 25 ≤ 30 < 40
  const r = assembleSettingsInjection(layers, { maxChars: 30 })
  expect(r.omitted).toEqual(['世界观'])
  expect(r.text.indexOf('甲')).toBeLessThan(r.text.indexOf('丙'))
  // 被丢层的声明行留在原层位置（甲 与 丙 之间）
  expect(r.text).toBe(`甲甲甲\n\n（设定超预算，已省略：世界观）\n\n丙丙丙`)
})

test('病态小预算：声明行本身就装不下 → 显式不注入，丢/截名单照报', () => {
  const layers: SettingsLayer[] = [
    { name: '本章设定', specificity: 'chapter', text: '甲'.repeat(3) },
    { name: '世界观', specificity: 'project', text: '乙'.repeat(30) },
    { name: '角色设定', specificity: 'volume', text: '丙'.repeat(3) },
  ]
  // 预算 6：丢完乙丙后两行声明(15+16)+分隔 已远超 6，截断甲也救不了 → 空串
  const r = assembleSettingsInjection(layers, { maxChars: 6 })
  expect(r.text).toBe('')
  expect(r.omitted).toEqual(['世界观', '角色设定'])
  expect(r.truncated).toEqual(['本章设定'])
})

test('code point 度量——emoji 计 1 不劈 surrogate pair', () => {
  const layers: SettingsLayer[] = [
    { name: '本章设定', specificity: 'chapter', text: '😀'.repeat(80) },
  ]
  // 预算 60：'😀'×80 按 code point 计 80 超预算 → 截断（若按 UTF-16 单元计是 160）
  const r = assembleSettingsInjection(layers, { maxChars: 60 })
  expect(r.truncated).toEqual(['本章设定'])
  expect(r.text.split(PRUNE_MARKER).length - 1).toBe(1)
  // 截断边界处 emoji 完整（无乱码代理孤对）
  const [head, tail] = r.text.split(PRUNE_MARKER)
  expect(head!.endsWith('😀')).toBe(true)
  expect(tail!.startsWith('😀')).toBe(true)
  expect(cpLen(r.text)).toBeLessThanOrEqual(60)
})

// ── ii 批（评审 #19 残余）：readCharacterCards stat 级缓存 ────────────────────

test('readCharacterCards 缓存：未变命中复用、变更重读、返回引用隔离', async () => {
  const { readCharacterCards, clearCharacterCardCache } = await import('../../src/process/settings-context.js')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cards-cache-'))
  try {
    writeFileSync(join(dir, '林远.md'), '---\n姓名: 林远\n身份: 首席大弟子\n---\n\n冷面剑修。\n')
    const bookRoot = dir
    const a = readCharacterCards(dir, bookRoot)
    expect(a[0]!.正文).toBe('冷面剑修。')
    // 引用隔离：调用方 mutate 不污染缓存
    a[0]!.正文 = '被改了'
    const b = readCharacterCards(dir, bookRoot)
    expect(b[0]!.正文).toBe('冷面剑修。')
    // 内容变更（mtime 变）→ 重读新内容
    writeFileSync(join(dir, '林远.md'), '---\n姓名: 林远\n身份: 首席大弟子\n---\n\n冷面剑修，剑心通明。\n')
    const c = readCharacterCards(dir, bookRoot)
    expect(c[0]!.正文).toBe('冷面剑修，剑心通明。')
    // 新增卡：下一轮 readdir 自愈
    writeFileSync(join(dir, '赵衡.md'), '---\n姓名: 赵衡\n---\n\n长老。\n')
    expect(readCharacterCards(dir, bookRoot).length).toBe(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    clearCharacterCardCache()
  }
})
