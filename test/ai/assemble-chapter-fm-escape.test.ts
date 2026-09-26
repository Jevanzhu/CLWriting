/**
 * R43-3（四十三轮）回归：assembleChapter fm 值侧 stringifyValue 转义（escape-unquote 对称闭环）。
 *
 * 修复前 AI 产出的自由文本（标题/目标情绪/核心反转）原样拼进 fm 行——含 `#`（读回被
 * 行内注释剥离截断）、`[`/`,`（解析成数组）、`|`/`>`（命中块标量分支吞后续 fm 行）、
 * 纯数字（解析成 number）的值落盘后读回静默损坏。修复后走系统写侧单源 stringifyValue。
 */
import { describe, expect, it } from 'vitest'
import { assembleChapter } from '../../src/ai/contract/chapter.js'
import { splitFrontMatter } from '../../src/format/frontmatter-core.js'
import { parseFlat } from '../../src/format/frontmatter.js'

/** 组装 → 落盘文本 → 读回解析，返回读回的 fm Map（round-trip 通道）。 */
function roundTrip(o: Record<string, unknown>, chapter: number) {
  const r = assembleChapter(o, chapter)
  if (!r.ok) throw new Error(r.error)
  const sp = splitFrontMatter(r.content)
  if (!sp) throw new Error('fm 未闭合（round-trip 夹具异常）')
  return { map: parseFlat(sp.fmRaw), content: r.content }
}

describe('R43-3: AI fm 自由文本 round-trip（stringifyValue 单源）', () => {
  it('标题含行内注释形态 `番外 #3` → 读回原样（修复前被截成「番外」）', () => {
    const { map } = roundTrip({ 标题: '番外 #3', 正文: '正文一句' }, 7)
    expect(map.get('标题')).toBe('番外 #3')
  })

  it('标题以 # 开头 → 读回原样（修复前值整体变空）', () => {
    const { map } = roundTrip({ 标题: '#标记标题', 正文: '正文' }, 7)
    expect(map.get('标题')).toBe('#标记标题')
  })

  it('标题含 `[`/`,` → 读回仍是字符串非数组', () => {
    const { map } = roundTrip({ 标题: '[终,局]', 正文: '正文' }, 7)
    expect(map.get('标题')).toBe('[终,局]')
  })

  it('标题恰为 `|` → 不命中块标量分支，后续 fm 行不丢（修复前「场景」行被吞）', () => {
    const { map } = roundTrip({ 标题: '|', 场景: '夜市', 正文: '正文' }, 7)
    expect(map.get('标题')).toBe('|')
    expect(map.get('场景')).toBe('夜市')
  })

  it('纯数字标题 → 读回仍是字符串', () => {
    const { map } = roundTrip({ 标题: '2046', 正文: '正文' }, 7)
    expect(map.get('标题')).toBe('2046')
  })

  it('常规中文值不加引号（写面不虚胖，读回恒等）', () => {
    const { content, map } = roundTrip({ 标题: '北境的雪', 钩子类型: '悬念钩', 正文: '正文' }, 1)
    expect(content).toContain('标题: 北境的雪')
    expect(map.get('标题')).toBe('北境的雪')
    expect(map.get('钩子类型')).toBe('悬念钩')
  })
})
