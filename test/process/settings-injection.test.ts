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

// ── 内存闸（2026-08-24 审计 C1）：cardCache FIFO 上限 64 + 删除自愈 ────────────────────
// 探测手法（与 chapters-cache.test.ts 的 mtime+size 撞车反证同款）：每次写盘后 utimes
// 回拨到同一固定 Date——同长改写 + 同一时间戳 → (mtime,size) 恒等：键仍在缓存 → 命中
// 旧内容；键已被淘汰/清扫 → 现读新内容。以此间接观测键的去留。

test('cardCache FIFO 上限 64：塞超后最旧键失活、活跃键仍命中（命中不续位）', async () => {
  const { readCharacterCards, clearCharacterCardCache } = await import('../../src/process/settings-context.js')
  const { mkdtempSync, rmSync, writeFileSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cards-fifo-'))
  const T = new Date(1_700_000_000_000)
  const write = (name: string, body: string): void => {
    writeFileSync(join(dir, name), `---\n姓名: ${name.replace('.md', '')}\n---\n\n${body}\n`)
    utimesSync(join(dir, name), T, T)
  }
  try {
    // 插入序可控的三段（不依赖 readdir 顺序）：Z 最旧 → 63 张 B → C 最新，共 65 次 set > 64。
    // 探测必须隔离进行：超限目录每轮 readdir 都会让被淘汰键 miss → 重插入引发「淘汰→
    // 下一键 miss→再淘汰」的连锁，若同一轮里既探最旧键又探活跃键，连锁会把活跃键在
    // 轮到它之前挤掉。故先删 Z 消除超限（活跃键探测轮 = 64 文件对 64 键，零 miss 确定性
    // 命中），再重建 Z 单独探其失活。
    write('Z.md', '旧Z。')
    expect(readCharacterCards(dir, dir)).toHaveLength(1)
    for (let i = 1; i <= 63; i++) write(`B${String(i).padStart(2, '0')}.md`, `乙${i}。`)
    readCharacterCards(dir, dir)
    write('C.md', '旧C。')
    expect(readCharacterCards(dir, dir)).toHaveLength(65) // 淘汰只影响缓存驻留，不影响输出

    // 删 Z 落回 64 文件 → 本轮零 miss（缓存恰为在盘 64 键），活跃键探测不受连锁干扰
    rmSync(join(dir, 'Z.md'))
    expect(readCharacterCards(dir, dir)).toHaveLength(64)
    // 同长改写 + 同一 T：C（最新插入、命中不续位仍为最新）→ 命中旧内容
    write('C.md', '新C。')
    const mid = readCharacterCards(dir, dir)
    expect(mid.find((c) => c.姓名 === 'C')!.正文).toBe('旧C。') // 活跃键仍命中

    // 重建 Z（同长 + 同一 T，stat 与被淘汰前恒等）：Z 键在塞入 C 时已被 FIFO 淘汰
    //（read3 的 seen 含 Z，清扫不会删它）→ miss 现读新内容
    write('Z.md', '新Z。')
    const after = readCharacterCards(dir, dir)
    expect(after.find((c) => c.姓名 === 'Z')!.正文).toBe('新Z。') // 最旧键失活（淘汰后 miss 现读）
    expect(after).toHaveLength(65)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    clearCharacterCardCache()
  }
})

test('cardCache 删除自愈：删卡后再读，缓存条目被清扫；他目录条目不受连坐', async () => {
  const { readCharacterCards, clearCharacterCardCache } = await import('../../src/process/settings-context.js')
  const { mkdtempSync, rmSync, writeFileSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir1 = mkdtempSync(join(tmpdir(), 'cards-heal1-'))
  const dir2 = mkdtempSync(join(tmpdir(), 'cards-heal2-'))
  const T = new Date(1_700_000_000_000)
  const write = (base: string, name: string, body: string): void => {
    writeFileSync(join(base, name), `---\n姓名: ${name.replace('.md', '')}\n---\n\n${body}\n`)
    utimesSync(join(base, name), T, T)
  }
  try {
    write(dir1, 'P.md', '旧P。')
    write(dir1, 'Q.md', '旧Q。')
    write(dir2, 'R.md', '旧R。')
    readCharacterCards(dir1, dir1)
    readCharacterCards(dir2, dir2)

    // 删 P → 下一轮 readdir 后 seen-set 清扫 P 键（输出少一张是 readdir 决定的，键清扫才是断言点）
    rmSync(join(dir1, 'P.md'))
    expect(readCharacterCards(dir1, dir1).map((c) => c.姓名)).toEqual(['Q'])

    // 同长改写 + 同一 T：P 键若已被清扫 → miss 现读新内容；若清扫失灵 → 命中旧内容
    write(dir1, 'P.md', '新P。')
    const again = readCharacterCards(dir1, dir1)
    expect(again.find((c) => c.姓名 === 'P')!.正文).toBe('新P。')
    expect(again.find((c) => c.姓名 === 'Q')!.正文).toBe('旧Q。') // 同目录存活键不受影响

    // dir2 的 R 键不受 dir1 清扫连坐（清扫按目录前缀，非全表）：仍命中旧内容
    write(dir2, 'R.md', '新R。')
    const r2 = readCharacterCards(dir2, dir2)
    expect(r2.find((c) => c.姓名 === 'R')!.正文).toBe('旧R。')
  } finally {
    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    clearCharacterCardCache()
  }
})

// ── R65-32（第六十五轮）：降级分支二次裸读容错——单卡读失败跳过，其余卡正常 ──────

test('readCharacterCards：无 fm 卡读盘失败（EACCES）→ 跳过该卡，其余卡正常返回（不再直穿抛出）', async () => {
  const { readCharacterCards, clearCharacterCardCache } = await import('../../src/process/settings-context.js')
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'cards-eacces-'))
  try {
    // 一张正常无 fm 卡（走降级分支：姓名=文件名，正文=全文）+ 一张不可读卡（无 fm 也无读权）
    writeFileSync(join(dir, '林远.md'), '冷面剑修，旧自由 MD 无 front matter。\n')
    writeFileSync(join(dir, '坏卡.md'), '读不出来的内容\n')
    chmodSync(join(dir, '坏卡.md'), 0o000) // 自然故障：readFile 失败 → 降级分支裸 readFileSync 再抛 EACCES
    // 修复前：此处直穿抛 EACCES（无 fm 与读盘失败混在同一 else）；修复后跳过坏卡
    const cards = readCharacterCards(dir, dir)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.姓名).toBe('林远')
    expect(cards[0]!.正文).toContain('冷面剑修')
  } finally {
    chmodSync(join(dir, '坏卡.md'), 0o644) // 还原权限供清理
    rmSync(dir, { recursive: true, force: true })
    clearCharacterCardCache()
  }
})
