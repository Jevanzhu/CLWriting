/**
 * R0912-7（2026-09-11 修复批）回归：learn 金句过滤改码位口径。
 *
 * 背景：金句候选长度过滤用 s.length（UTF-16 码元）——含增补平面字符（emoji/生僻字）
 * 的句子 length 偏大（代理对一符双计），被 50 上限误杀，与全库 code point 口径
 * （P-7/R72-7 族）不一致。修复：按码位计数（阈值 10/50 语义不变）。
 *
 * 判定句：41 码位（12 BMP 前缀 + 12 个 emoji + 17 BMP 后缀）＝ 54 码元——修复前
 * UTF-16 length 54 > 50 被误杀，修复后码位 41 ∈ [10,50] 正常入选金句候选
 *（句含「忽然」钩子 + 「痛」情绪，过特征闸）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learnFromBook } from '../../src/learn/index.js'
import { codePointLength } from '../../src/process/summary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const EMOJI = '😀' // 增补平面：1 码位 = 2 码元
const SENTENCE = '他忽然感到一阵锥心之痛，' + EMOJI.repeat(12) + '仿佛有许许多多旧事在血里翻身的重量'

function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'learn-quote-cp-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-定稿章.md'),
    `---\n章号: 1\n标题: 定稿章\n---\n${SENTENCE}\n`,
    'utf-8',
  )
  return root
}

test('R0912-7: 判定句前置恒等式——码位 ∈ [10,50] 而 UTF-16 码元 > 50（修复前必被误杀）', () => {
  expect(SENTENCE.length).toBeGreaterThan(50) // 54 码元：旧口径 s.length <= 50 不成立
  const cp = codePointLength(SENTENCE)
  expect(cp).toBeGreaterThanOrEqual(10)
  expect(cp).toBeLessThanOrEqual(50) // 41 码位：新口径入选
})

test('R0912-7: 含增补平面字符的长句按码位入选金句候选（修复前被 50 上限误杀）', async () => {
  const root = makeBook()
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    const quotes = r.quotes ?? []
    expect(quotes.some((q) => q.正文 === SENTENCE)).toBe(true)
    // 候选落盘同步可见（金句/<场景>.md）
    const quoteFile = join(root, '工作区', 'learn候选', '金句', '通用.md')
    expect(existsSync(quoteFile)).toBe(true)
    expect(readFileSync(quoteFile, 'utf8')).toContain(SENTENCE)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
