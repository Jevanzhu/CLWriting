/**
 * 四轮-D405（2026-09-18 全量源码独立重评四轮修复批）回归：
 * 短篇分布并列排序的次级键 localeCompare(value, 'zh-Hans') 随宿主 ICU/locale
 * 漂移——同 count 并列时相对序不稳定。先例：version.ts R0912-5 已废
 * localeCompare 改字节序（比较器收编单源）。
 * 修复：改 UTF-16 码元序比较（a<b?-1:a>b?1:0）。
 * 固定数据断言：'B口味'（B=U+0042）与 'a口味'（a=U+0061）并列时码元序 B 在前
 * （zh-Hans 字母序则 a 在前——实测 localeCompare 返回 -1，两种口径可区分）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChapter } from '../helpers/chapter.js'
import { writePieceList } from '../../src/format/manifest.js'
import { analyzeShortCollection, scanShortCollection } from '../../src/metrics/short-index.js'
import type { PieceList } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造一篇短篇（正文 + 章纲；结尾味道来自情绪曲线末段） */
function makePiece(root: string, num: number, title: string, ending: string): void {
  const name = `${String(num).padStart(3, '0')}-${title}.md`
  const bodyDir = join(root, '写作', '正文', '第一卷')
  mkdirSync(bodyDir, { recursive: true })
  writeChapter(
    join(bodyDir, name),
    {
      章号: num,
      标题: title,
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '压抑',
      目标情绪: '惊悚',
      核心反转: '来客就是死者',
    },
    `正文 ${title}`,
  )
  const list: PieceList = {
    反转线索表: {
      核心反转: '来客就是死者',
      铺垫点: [{ 位置: '开头钩子', 内容: '门外没有脚印' }],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: '惊悚', 强度: 3 },
      { 段落: '余韵', 情绪: ending, 强度: 6 },
    ],
    伏笔回收: [{ 伏笔: '门外没有脚印', 回收位置: '结尾' }],
  }
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writePieceList(join(root, '大纲', '章纲', name), list)
}

test('四轮-D405: 并列 count 的分布值按码元序（B口味 前于 a口味，与 locale 无关）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'd405-short-tie-'))
  try {
    makePiece(root, 1, '雪夜', 'B口味')
    makePiece(root, 2, '雨巷', 'a口味')
    const entries = scanShortCollection(root)
    const report = analyzeShortCollection(entries)
    const endings = report.planning.endingFlavors
    // 并列前提：两者 count 相等
    expect(endings.map((d) => d.count)).toEqual([1, 1])
    // 码元序：B（U+0042）< a（U+0061）；localeCompare('a口味','B口味','zh-Hans')
    // = -1（字母序 a 在前），修复前此断言随宿主 ICU 漂移
    expect(endings.map((d) => d.value)).toEqual(['B口味', 'a口味'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('四轮-D405: count 优先级不变——高 count 恒在前，并列才看码元序', () => {
  const root = mkdtempTracked(join(tmpdir(), 'd405-short-count-'))
  try {
    makePiece(root, 1, '雪夜', 'B口味')
    makePiece(root, 2, '雨巷', 'B口味')
    makePiece(root, 3, '孤灯', 'a口味')
    const entries = scanShortCollection(root)
    const report = analyzeShortCollection(entries)
    const endings = report.planning.endingFlavors
    expect(endings.map((d) => [d.value, d.count])).toEqual([
      ['B口味', 2],
      ['a口味', 1],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
