/**
 * R30-1（三十轮）回归：跨段引号吞噬致禁词红闸静默漏报。
 *
 * 修法：QUOTED_SPAN_RE 内部字符类补排换行（quotes.ts）——引号片段不跨行。
 * 消费方排查结论：整 body 调用方 checkBannedWords / checkOpeningNoEnv 此修后
 * 漏报面闭合；单行调用方（computeStyleMetrics 对话行识别 / checkNewNames 逐行
 * span 抽取）行为逐字不变（quotes-matrix.test.ts 契约行同步）。
 */
import { test, expect } from 'vitest'
import { checkBannedWords, checkOpeningNoEnv } from '../../src/check/count.js'
import { stripQuotedSpans, QUOTED_SPAN_RE } from '../../src/check/quotes.js'

// ── 复现 63 字场景：漏写闭引号 + 后文任意闭引号 → 旧实现吞掉中间全部叙述 ──

test('R30-1: 漏写闭引号的多段文本，第二段叙述的禁词必须被检出（不再跨段吞噬）', () => {
  // 第一段对白漏写闭引号（AI 草稿常见）；第三段的「别问了。」是后文任意闭引号。
  // 旧实现：span = 从首「一路吞到「别问了。」的 」，第二段「仿佛凝固」随叙述一起
  // 被剥除 → 禁词红闸静默漏报（63 字正文剥掉 60 字同型）。
  const body = [
    '「你到底想说什么。她没有回答，', // 第一段：对白漏写闭引号
    '夜风穿堂而过，她的脸色，仿佛凝固。', // 第二段叙述：禁词在此，前后皆标点（边界命中）
    '「别问了。」他转身离开。', // 第三段：后文任意闭引号（旧实现吞到这里）
  ].join('\n')
  const r = checkBannedWords(body, ['仿佛凝固'])
  expect(r.items.some((i) => i.checkId === 'banned-word' && i.level === 'red')).toBe(true)
})

test('R30-1: 同一行内成对引号仍正常剥除（对白不算作者叙述用词，不回归误报）', () => {
  // 引号片段在同一行内闭合 → 照旧成 span 剥除，禁词在引号内不报红
  const body = '他压低声音说了句「仿佛凝固」，然后闭嘴。'
  const r = checkBannedWords(body, ['仿佛凝固'])
  expect(r.items.every((i) => i.level !== 'red')).toBe(true)
})

test('R30-1: 单行成对引号剥除语义逐字不变（原语层锁定）', () => {
  expect(stripQuotedSpans('前「一」中“二”后')).toBe('前中后')
  expect(stripQuotedSpans('「嵌“套”」余')).toBe('」余')
  expect(QUOTED_SPAN_RE.test('「混搭”')).toBe(true) // 跨体系配对维持（quotes-matrix 契约）
})

// ── checkOpeningNoEnv 同源受影响面：opening 窗口剥 span 同样不再跨段吞噬 ──

test('R30-1: opening 窗口内漏写闭引号，后段叙述的环境词不再被吞（漏报面闭合）', () => {
  const body = [
    '「今天天气真好。她笑了。', // 对白漏写闭引号
    '他们沿着街道走进树林深处。', // 叙述：环境词
    '「走吧。」他说。', // 后文闭引号（旧实现吞到这里）
  ].join('\n')
  const r = checkOpeningNoEnv(body)
  expect(r.items.some((i) => i.checkId === 'opening-env' && i.message.includes('天气'))).toBe(true)
})

test('R30-1: opening 同行成对引号的环境对白照旧豁免（不引入误报）', () => {
  const body = '「今天天气真好。」\n他拔剑直取对方咽喉。'
  const r = checkOpeningNoEnv(body)
  expect(r.items).toHaveLength(0)
})
