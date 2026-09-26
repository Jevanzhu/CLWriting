import { test, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAllChecks } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writePieceList } from '../../src/format/manifest.js'
import type { ChapterMeta, BookConfig, PieceList } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r36-30-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function shortConfig(): BookConfig {
  return { ...DEFAULT_CONFIG, kind: 'short', short: {} }
}

/** 造短篇章纲（反转线索表 + 伏笔回收）：章纲与正文同名（runner.ts:225 口径）。 */
function setupOutline(list: PieceList, piecePath: string): void {
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  writeFileSync(piecePath, '---\n章号: 1\n标题: 雪夜\n---\n正文', 'utf-8')
  mkdirSync(join(tmp, '大纲', '章纲'), { recursive: true })
  writePieceList(join(tmp, '大纲', '章纲', '001-雪夜.md'), list)
}

function runShortCheck(piecePath: string) {
  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫', _path: piecePath }
  return runAllChecks({
    bookRoot: tmp,
    config: shortConfig(),
    chapter: ch,
    body: '正文',
    fileName: '001-雪夜.md',
  })
}

// ── R36-30：payoff 核对 detail 与 location 不再强制同值 ──────────
// 清单.md 伏笔回收仅承载 伏笔/回收位置/未回收 三字段，无独立「证据指向」列：
// - 回收条目：detail 缺省回退 location（同值只来自回退，非无条件复制）
// - 未回收条目：detail 显式标记「未回收」，与空 location 独立（可不同值）

test('r36-30: payoff 回收条目 detail 缺省回退 location，未回收条目 detail 独立', () => {
  const piecePath = join(tmp, '写作', '正文', '001-雪夜.md')
  setupOutline(
    {
      反转线索表: {
        核心反转: '来客即凶手',
        铺垫点: [
          { 位置: '开头', 内容: '门外没有脚印' },
          { 位置: '中段', 内容: '镜中没有影子' },
          { 位置: '尾声', 内容: '钟表倒走' },
        ],
      },
      伏笔回收: [
        { 伏笔: '半枚玉佩', 回收位置: '结尾' }, // 已回收：无独立 detail 来源
        { 伏笔: '断剑', 回收位置: '', 未回收: true }, // 未回收：location 空，detail 显式标记
      ],
    },
    piecePath,
  )

  const r = runShortCheck(piecePath)
  expect(r.byproducts?.pieceListChecks).toEqual([
    { type: 'reversal', subject: '来客即凶手', location: '开头', detail: '门外没有脚印' },
    { type: 'reversal', subject: '来客即凶手', location: '中段', detail: '镜中没有影子' },
    { type: 'reversal', subject: '来客即凶手', location: '尾声', detail: '钟表倒走' },
    // 回收条目：detail 缺省回退 location（不再无条件复制，字段仍各自承载）
    { type: 'payoff', subject: '半枚玉佩', location: '结尾', detail: '结尾' },
    // 未回收条目：detail 与 location 独立（'未回收' 与 空串不同值）
    { type: 'payoff', subject: '断剑', location: '', detail: '未回收' },
  ])
})

test('r36-30: detail 与 location 可独立承载不同值，同值仅出现在缺省回退路径', () => {
  const piecePath = join(tmp, '写作', '正文', '001-雪夜.md')
  setupOutline(
    {
      反转线索表: {
        核心反转: '来客即凶手',
        铺垫点: [
          { 位置: '开头', 内容: '门外没有脚印' },
          { 位置: '中段', 内容: '镜中没有影子' },
          { 位置: '尾声', 内容: '钟表倒走' },
        ],
      },
      伏笔回收: [
        { 伏笔: '半枚玉佩', 回收位置: '结尾' },
        { 伏笔: '断剑', 回收位置: '', 未回收: true },
      ],
    },
    piecePath,
  )

  const checks = runShortCheck(piecePath).byproducts?.pieceListChecks ?? []
  const reversal = checks.filter((c) => c.type === 'reversal')
  const payoffs = checks.filter((c) => c.type === 'payoff')
  const recovered = payoffs.find((p) => p.subject === '半枚玉佩')!
  const unrecovered = payoffs.find((p) => p.subject === '断剑')!

  // reversal：detail（铺垫内容）与 location（铺垫位置）本就是两个独立字段，互不相同
  for (const c of reversal) {
    expect(c.detail).not.toBe(c.location)
  }
  // 未回收 payoff：detail 显式标记 ≠ 空 location——两字段不被强制同值
  expect(unrecovered.location).toBe('')
  expect(unrecovered.detail).toBe('未回收')
  expect(unrecovered.detail).not.toBe(unrecovered.location)
  // 回收 payoff：detail 缺省回退 location（同值是回退关系，非强制复制出来的第二份）
  expect(recovered.detail).toBe(recovered.location)
  expect(recovered.location).toBe('结尾')
})