import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { appendAborted, appendPending, appendSettled, findUnsettled } from '../../src/document/journal.js'

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

// ── U-P2-9：journal 膨胀压缩（pending 含全文快照，日写线性涨）─────────

describe('journal compact（U-P2-9）', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-compact-'))
    j = join(dir, 'doc_1.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('超阈值的全结算 journal → settle 后压缩为空文件', () => {
    const big = '雪'.repeat(700 * 1024) // 单条 pending ≈ 0.7MB
    for (let i = 0; i < 4; i++) {
      const opId = appendPending(j, 'doc_1', null, big)
      appendSettled(j, opId, SHA(`sha256:s${i}`))
    }
    expect(statSync(j).size).toBe(0) // 已结算行全部丢弃
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('压缩保留未结算 pending（崩溃恢复资产不丢）', () => {
    const big = '雨'.repeat(700 * 1024)
    const settled1 = appendPending(j, 'doc_1', null, big)
    appendSettled(j, settled1, SHA('sha256:a')) // 1.4MB，未到阈值
    const alive = appendPending(j, 'doc_1', null, big + '尾巴') // 未结算
    const settled3 = appendPending(j, 'doc_1', null, big)
    appendSettled(j, settled3, SHA('sha256:b')) // 3.5MB → 触发压缩
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(alive)
    expect(u[0]!.content).toBe(big + '尾巴')
  })

  it('阈值以下不压缩（防高频重写 O(n²)）', () => {
    const opId = appendPending(j, 'doc_1', null, '小内容')
    appendSettled(j, opId, SHA('sha256:c'))
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"pending"') // 原行保留
    expect(text).toContain('"status":"settled"')
  })

  it('aborted 配对同样参与压缩', () => {
    const big = '风'.repeat(1100 * 1024)
    const opId = appendPending(j, 'doc_1', null, big)
    appendAborted(j, opId, '模拟磁盘满')
    expect(statSync(j).size).toBe(0)
    expect(findUnsettled(j)).toHaveLength(0)
  })
})
