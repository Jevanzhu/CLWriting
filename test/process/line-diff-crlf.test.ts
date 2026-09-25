/**
 * R2W-7（win 平台专项复审 R2）：lineDiff 行级等值的 CRLF 容忍。
 *
 * CRLF 正文（外部编辑器保存）× LF AI 产出此前逐行失配 → diff 退化成整文件删+加
 * 噪块（确认 UI 不可用）。修复后行尾 \r 不参与等值比较。
 */
import { describe, expect, it } from 'vitest'
import { lineDiff } from '../../src/process/rewrite-prompt.js'

describe('lineDiff CRLF 容忍（R2W-7）', () => {
  it('CRLF 原文 × LF 产出 → 相同行识别为 same（不再整文件 del+add）', () => {
    const original = '第一行\r\n第二行\r\n第三行\r\n'
    const produced = '第一行\n第二行（改）\n第三行\n'
    const diff = lineDiff(original, produced)
    const same = diff.filter((d) => d.type === 'same')
    expect(same.map((d) => d.text)).toContain('第一行')
    expect(same.map((d) => d.text)).toContain('第三行')
    // 全文件噪音不出现：del 侧不含未改动的行
    const del = diff.filter((d) => d.type === 'del').map((d) => d.text)
    expect(del).not.toContain('第一行')
    expect(del).not.toContain('第三行')
  })
})
