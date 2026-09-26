/**
 * 四轮-D401（2026-09-18 全量源码独立重评四轮修复批）回归：
 * 伏笔命中片段按 ±SNIPPET_RADIUS(15) UTF-16 码元切片，边界可落在代理对中间——
 * emoji/扩展区汉字恰在边界时片段边缘劈出孤立代理对（乱码），且该片段参与
 * searchForeshadowTrails 的命中片段检索。
 * 修复：切片边界按码点回退（先例：journal.ts truncateSnapshotHeadTail 切点回退
 * 手法）；SNIPPET_RADIUS 半径语义 ±1 码元浮动可接受。
 * 断言口径：片段逐码元扫描无孤立代理对（孤立高代理无随行低代理/孤立低代理无
 * 前导高代理均判坏）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readForeshadows, scanForeshadowTrails } from '../../src/document/foreshadow.js'

let root: string

/** 造一章正文（写作/正文/第一卷/0001-标题.md） */
function writeChapter(章号: number, title: string, body: string): void {
  const dir = join(root, '写作', '正文', '第一卷')
  mkdirSync(dir, { recursive: true })
  const name = `${String(章号).padStart(4, '0')}-${title}.md`
  writeFileSync(join(dir, name), `---\n章号: ${章号}\n标题: ${title}\n---\n${body}\n`, 'utf-8')
}

/** 造一个设定伏笔（设定/伏笔/标题.md） */
function writeForeshadow(title: string, fm: Record<string, string> = {}): void {
  const dir = join(root, '设定', '伏笔')
  mkdirSync(dir, { recursive: true })
  const fmLines = Object.entries({ 标题: title, ...fm })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(join(dir, `${title}.md`), `---\n${fmLines}\n---\n`, 'utf-8')
}

/** 逐 UTF-16 码元扫描：存在孤立代理对 → true（用 charCodeAt 半边判定，for..of
 *  按码点迭代会静默吞掉孤立代理对，检不出来） */
function hasOrphanSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = i > 0 ? s.charCodeAt(i - 1) : 0
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true
    }
  }
  return false
}

test('四轮-D401: 命中词后 15 码元处恰为 emoji 代理对 → 片段尾不劈对（end 边界回退）', () => {
  root = mkdtempTracked(join(tmpdir(), 'clw-d401-end-'))
  try {
    // 前缀布局（相对命中词）：'玉佩'(2 码元) + 14 个 BMP 字母 = 16 码元，end =
    // idx + 2 + 15 = 17 恰落在 🔥（U+1F525，码元 16-17）高低半之间——修复前
    // slice(0, 17) 片段以孤立高代理结尾
    writeForeshadow('火签', { 关联词: '玉佩', 重要性: '中', 埋设章号: '1' })
    writeChapter(1, '埋', '玉佩abcdefghijklmn🔥。')
    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const hit = trails.get('火签')!.hits[0]!
    expect(hit.命中片段).toContain('玉佩')
    expect(hit.命中片段.endsWith('n')).toBe(true) // 修复前以孤立高代理结尾
    expect(hasOrphanSurrogate(hit.命中片段)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('四轮-D401: 命中词前 15 码元处恰为扩展区汉字代理对 → 片段头不劈对（start 边界回退）', () => {
  root = mkdtempTracked(join(tmpdir(), 'clw-d401-start-'))
  try {
    // 前缀布局：4 个 BMP + 𠀀（U+20000，码元 4-5）+ 14 个 BMP = 20 码元，start =
    // idx - 15 = 5 恰落在 𠀀 低半——修复前 slice(5, …) 片段以孤立低代理开头
    writeForeshadow('古镜', { 关联词: '铜镜', 重要性: '中', 埋设章号: '1' })
    writeChapter(1, '埋', '甲乙丙丁𠀀戊己庚辛壬癸甲乙丙丁戊己庚辛铜镜，镜中映出旧事。')
    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const hit = trails.get('古镜')!.hits[0]!
    expect(hit.命中片段).toContain('铜镜')
    expect(hit.命中片段.startsWith('𠀀')).toBe(true) // 修复前以孤立低代理开头
    expect(hasOrphanSurrogate(hit.命中片段)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
