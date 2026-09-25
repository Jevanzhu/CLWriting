/**
 * R0911-E-P3-5（2026-09-11 全量重评 GLM-5.3 修复批）回归：matchFenceLine 缩进
 * 判定钉死 CommonMark 口径（缩进只计空格）。
 *
 * 原正则 `\s{0,3}` 把 tab 也计入缩进容忍——CommonMark 中 tab 缩进的 ``` 行按
 * 4 列进 indented code block，不是围栏行；tab 缩进被误判围栏会在导出翻转/机检
 * 计节两消费方错切围栏窗。修复为 ` {0,3}` 后锁三面口径：tab 缩进不判围栏、
 * 0-3 空格照常判、4 空格照旧不判（indented code block）。
 */
import { test, expect } from 'vitest'
import { matchFenceLine } from '../../src/format/fence.js'

test('R0911-E-P3-5: tab 缩进的 ``` / ~~~ 不判围栏（CommonMark：tab 计 4 列进 indented code block）', () => {
  expect(matchFenceLine('\t```js')).toBeNull()
  expect(matchFenceLine('\t```')).toBeNull()
  expect(matchFenceLine('\t~~~')).toBeNull()
  // 空格后接 tab 的混合形态：tab 不是合法缩进字符，前缀对不上围栏字符起点 → 同不判
  expect(matchFenceLine(' \t```')).toBeNull()
})

test('R0911-E-P3-5: 0-3 空格缩进照常判围栏（修复只收紧 tab，不收窄空格容忍）', () => {
  const cases = ['```', ' ```', '  ```', '   ```js']
  for (const line of cases) {
    const m = matchFenceLine(line)
    expect(m, line).not.toBeNull()
    expect(m!.ch).toBe('`')
    expect(m!.len).toBe(3)
  }
  expect(matchFenceLine('```js')!.info).toBe('js')
  expect(matchFenceLine('   ```js')!.info).toBe('js')
  // ~~~ 族同口径
  const t = matchFenceLine('  ~~~')
  expect(t).not.toBeNull()
  expect(t!.ch).toBe('~')
  expect(t!.len).toBe(3)
})

test('R0911-E-P3-5: 4 空格缩进照旧不判（indented code block 口径不变）', () => {
  expect(matchFenceLine('    ```')).toBeNull()
  expect(matchFenceLine('    ~~~')).toBeNull()
})

test('R0911-E-P3-5: 其余既有口径不回归——CRLF 尾容忍与信息串', () => {
  // R33-1：行尾残 \r 不破匹配，信息串不含 \r
  const crlf = matchFenceLine('  ```x\r')
  expect(crlf).not.toBeNull()
  expect(crlf!.info).toBe('x')
  // 长围栏字符连写照常（len = 连写长度）
  expect(matchFenceLine('`````')!.len).toBe(5)
})
