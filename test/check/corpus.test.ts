/**
 * B3（批 6）：语料回归门（golden-master）——把仓库固化的真实语料摘录重放过当前
 * 检查器，词表/阈值/规则改动复活一个误报就红 CI（测试从构造样例升级为真实文本，
 * 直接回应评审 5.2-4）。
 *
 * 用例源：test/corpus/checks/<checkId>.json（形如 [{excerpt, expect}]）——
 * `npm run corpus:harvest` 自举产出候选 → 作者勾选 → `npm run corpus:commit` 入库。
 * 空目录（新书/未自举）整组 skip，不影响 CI；入库 ≥1 条起即刻生效。
 *
 * expect 语义：silent = 作者判误报（当前检查器不得再命中该 checkId）；
 * fire = 作者认可命中（当前检查器仍须命中——防止规则误修把真命中弄丢）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAllChecks } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta } from '../../src/format/types.js'

interface CorpusEntry {
  excerpt: string
  expect: 'fire' | 'silent'
}

/** 语料装载：目录 → checkId → entries；空/缺/坏文件容错（不入门不炸门） */
export function loadCorpusFrom(dir: string): Map<string, CorpusEntry[]> {
  const out = new Map<string, CorpusEntry[]>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    try {
      const entries = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CorpusEntry[]
      if (Array.isArray(entries) && entries.length > 0) {
        out.set(f.replace(/\.json$/, ''), entries)
      }
    } catch (e) {
      // R63-11：坏文件不再静默跳过——动态用例数下降会被 check:counts 绊红，但信号
      // 是数字失配而非语料门坏（排障误导）；此处 warn 指名文件与原因
      console.warn(`[corpus] 语料文件解析失败，跳过该文件（不入门但不静默）：${f}（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
  return out
}

// R64-42（十二轮）：cwd 相对路径改 import.meta.url 解析根——非仓库根 cwd 直接跑
// 时 existsSync false → 语料回归门整组静默跳过（不红）。R62-58 同款修法。
const CORPUS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'corpus', 'checks')

/** 最小无布线书（通用检查器确定性运行；checkId 相关输入走内置默认） */
let bookRoot = ''
beforeAll(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-corpus-gate-'))
  mkdirSync(join(bookRoot, '文风'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 语料门\nhost: cc\nleads:\n  enabled: []\n')
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), '# 文风铁律\n')
})
afterAll(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

describe('B3 装载器容错', () => {
  it('缺目录 → 空 Map（skipIf 语义）', () => {
    expect(loadCorpusFrom(join('test', 'corpus', 'checks-not-exist'))).toEqual(new Map())
  })

  // R63-11：标题此前宣称「坏 json 文件跳过」但断言只覆盖缺目录分支——补齐坏文件分支：
  // 坏文件跳过（warn 不炸门）、好文件照常入门、_ 前缀豁免
  it('坏 json 文件跳过（warn 不炸门）；好文件照常入门；_ 前缀豁免', () => {
    const d = mkdtempSync(join(tmpdir(), 'clw-corpus-bad-'))
    try {
      writeFileSync(join(d, 'bad-check.json'), 'NOT JSON {{{')
      writeFileSync(join(d, 'empty-check.json'), '[]') // 空数组不入门（与坏文件同不入门，但路径不同）
      writeFileSync(join(d, 'good-check.json'), JSON.stringify([{ excerpt: '正文。', expect: 'fire' }]))
      writeFileSync(join(d, '_meta.json'), '[{"x":1}]')
      const m = loadCorpusFrom(d)
      expect(m.has('bad-check')).toBe(false)
      expect(m.has('empty-check')).toBe(false)
      expect(m.has('_meta')).toBe(false)
      expect(m.get('good-check')).toEqual([{ excerpt: '正文。', expect: 'fire' }])
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

const corpus = loadCorpusFrom(CORPUS_DIR)

describe.skipIf(corpus.size === 0)('B3 语料回归门（golden-master：真实语料 × 当前检查器）', () => {
  const chapter: ChapterMeta = {
    章号: 1,
    标题: '语料章',
    钩子类型: '悬念钩',
    钩子强弱: '中',
    情绪定位: '铺垫',
  }
  for (const [checkId, entries] of corpus) {
    describe(`checkId: ${checkId}（${entries.length} 条）`, () => {
      for (const [i, entry] of entries.entries()) {
        const label = entry.excerpt.slice(0, 18).replace(/\n/g, ' ')
        it(`#${i} ${entry.expect === 'silent' ? '不得命中' : '须命中'}「${label}…」`, () => {
          const report = runAllChecks({
            bookRoot,
            config: DEFAULT_CONFIG,
            chapter,
            body: entry.excerpt,
            fileName: '0001-语料章.md',
          })
          const fired = report.sections.some((s) => s.items.some((it) => it.checkId === checkId))
          if (entry.expect === 'silent') {
            expect(fired, `误报复活：checkId=${checkId} 不应再命中该真实语料——\n摘录：${entry.excerpt}`).toBe(false)
          } else {
            expect(fired, `真命中丢失：checkId=${checkId} 仍须命中该语料——\n摘录：${entry.excerpt}`).toBe(true)
          }
        })
      }
    })
  }
})
