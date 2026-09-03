/**
 * R42-34（四十二轮）：book.yaml 解析入口（parseBookConfig）剥前导 BOM。
 *
 * 首行带 \uFEFF（win 记事本「UTF-8 with BOM」保存形态）此前全凭 trim() 恰好剥
 * ZWNBSP 才不出键名事故，且首行缩进被多计 1——首个段的 1 空格/tab 缩进子行被
 * 弹栈提为顶层键后静默丢弃。修复后：入口窄剥 BOM（不归一行尾），键/段/结构均按
 * 无 BOM 形解析。同缺陷族先例 r2w6-yaml-bom（补丁族）/ r37-yaml-bom-keyline。
 */
import { describe, expect, it } from 'vitest'
import { parseBookConfig } from '../../src/format/yaml.js'

const BOM = '\uFEFF'

describe('R42-34: book.yaml 解析入口 BOM 剥除', () => {
  it('BOM + kind: short 首行 → 解析出 short（不被静默路由长篇轨）', () => {
    const r = parseBookConfig(`${BOM}kind: short\nhost: cc\nbook:\n  title: 测试\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.kind).toBe('short')
  })

  it('BOM + spec_version 首键 → 键被认（不回落默认 1）', () => {
    const r = parseBookConfig(`${BOM}spec_version: 3\nhost: cc\nbook:\n  title: 测试\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.spec_version).toBe(3)
  })

  it('BOM 首段 + 1 空格缩进子行 → 子键仍挂首段（首行缩进不再多计 1）', () => {
    // 修复前：BOM 计入缩进（首段 indent=1）→ 1 空格子行弹栈提为顶层键 → title 静默丢
    const r = parseBookConfig(`${BOM}book:\n title: 一空格子行\nhost: cc\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.book.title).toBe('一空格子行')
  })

  it('BOM + CRLF 混形 → 行尾容忍语义维持（窄剥 BOM 不动 CRLF）', () => {
    const r = parseBookConfig(`${BOM}kind: short\r\nhost: cc\r\nbook:\r\n  title: 换行书\r\n`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.kind).toBe('short')
      expect(r.config.book.title).toBe('换行书')
    }
  })

  it('无 BOM 文件零变化（replace 无命中，回归锚）', () => {
    const r = parseBookConfig('kind: short\nhost: cc\nbook:\n  title: 无BOM\n')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.kind).toBe('short')
      expect(r.config.book.title).toBe('无BOM')
    }
  })
})
