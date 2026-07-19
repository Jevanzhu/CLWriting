import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPending, appendSettled, findUnsettled } from '../../src/document/journal.js'

const SHA = (s: string) => s as `sha256:${string}`

describe('journal', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-'))
    j = join(dir, 'doc_1.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appendPending 返回 ULID opId，文件含 pending + 全文', () => {
    const opId = appendPending(j, 'doc_1', null, '正文内容')
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"pending"')
    expect(text).toContain('正文内容')
  })

  it('pending + settled 配对 → findUnsettled 为空', () => {
    const opId = appendPending(j, 'doc_1', null, 'x')
    appendSettled(j, opId, SHA('sha256:abc'))
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('pending 无 settled → findUnsettled 返回该条目（含全文快照）', () => {
    appendPending(j, 'doc_1', null, '未结算')
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.content).toBe('未结算')
  })

  it('多 opId 混合 → 只返回未结算的', () => {
    const a = appendPending(j, 'doc_1', null, 'a')
    const b = appendPending(j, 'doc_1', null, 'b')
    appendSettled(j, a, SHA('sha256:1'))
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(b)
  })

  it('文件不存在 → findUnsettled 空', () => {
    expect(findUnsettled(join(dir, '无.jsonl'))).toHaveLength(0)
  })

  it('非法行跳过降级', () => {
    appendPending(j, 'doc_1', null, 'x')
    appendFileSync(j, '非法行\n{bad json\n')
    expect(findUnsettled(j)).toHaveLength(1)
  })
})
