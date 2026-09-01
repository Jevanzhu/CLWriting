/**
 * R36-1 同族第四处（三十六轮）回归：短篇清单正文 `##` 锚点采集的 CRLF 容忍。
 *
 * 修复背景：collectBodyAnchors 对按 '\n' split 的**未 trim 原始行**做 `$` 锚定匹配且无
 * m 标志——CRLF 章文件的 `##` 锚点行尾残留 \r 全部失配 → anchors=[] → anchoredSetupCount
 * 虚报 0、「铺垫正文锚点位置回指不足」假 issue（评分/报告误判）。修复：正则加 `\r?`。
 */
import { test, expect } from 'vitest'
import { collectBodyAnchors } from '../../src/metrics/short-index.js'

test('R36-1: CRLF 正文的 ## 锚点全部采出（修复前为空）', () => {
  const bodyCrlf = [
    '## 第一幕',
    '正文行一。',
    '## 第二幕',
    '正文行二。',
    '### 子节（不采，## 级才锚）',
  ].join('\r\n')
  const anchors = collectBodyAnchors(bodyCrlf)
  expect(anchors).toEqual(['第一幕', '第二幕'])
})

test('R36-1: LF 与 CRLF 锚点采集结果逐位一致（防退化）', () => {
  const bodyLf = [
    '## 第一幕',
    '正文行一。',
    '## 第二幕',
    '正文行二。',
  ].join('\n')
  expect(collectBodyAnchors(bodyLf.split('\n').join('\r\n'))).toEqual(collectBodyAnchors(bodyLf))
})

test('R36-1: 无锚点/空正文仍为空数组（语义不变）', () => {
  expect(collectBodyAnchors('正文无标题。')).toEqual([])
  expect(collectBodyAnchors('')).toEqual([])
})