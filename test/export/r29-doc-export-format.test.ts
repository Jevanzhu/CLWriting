/**
 * C-9（二十九轮）回归：export format 非法值显式参数错误，不再误报「正文为空」。
 *
 * 背景：format 经 API/worker 透传任意 JSON 可达（运行期不受 TS 类型约束），非法值
 * 此前让 doMerged/doSplit 双 false，全部章静默跳过写入后落到「零产出」收口，误报
 * 「正文全部为空或读取失败」——病因完全错位。修复后入口校验 format ∈
 * {merged,split,both}，非法值显式参数错误返回，不做任何盘上操作。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook, type ExportFormat } from '../../src/export/index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r29-expfmt-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('C-9 / export format 入口校验', () => {
  it('非法 format（"xml"）→ 参数错误返回，不误报正文为空、无产物', () => {
    const r = exportBook({ bookRoot: root, format: 'xml' as unknown as ExportFormat })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('参数错误')
    expect(r.error).toContain('format')
    expect(r.error).not.toContain('正文全部为空')
    expect(r.error).not.toContain('正文为空')
    expect(r.files).toEqual([])
    expect(r.chapterCount).toBe(0)
  })

  it('非法 format（非字符串 123）→ 同样参数错误（运行期任意 JSON 透传面）', () => {
    const r = exportBook({ bookRoot: root, format: 123 as unknown as ExportFormat })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('参数错误')
  })

  it('合法 format 通过校验，走正常空书报错（错误归因正确：无正文而非参数）', () => {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有定稿正文可导出')
    expect(r.error).not.toContain('参数错误')
  })
})
