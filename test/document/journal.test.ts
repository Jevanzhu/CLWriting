import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'

// ── KN-H-1（2026-08-23）：compact 跨进程竞态确定性复现 ──
// mock node:fs 的 readFileSync：findUnsettled 读 journal 时（flag 开且路径命中），
// 先读出内容、再向文件追加一行他进程 pending、最后返回「追加前」的内容——精确模拟
// 「compact 读完成后、整文件替换前，另一进程 append」的危险时序（原实现此行被吞）。
const RACE = vi.hoisted(() => ({ inject: false, journalPath: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      const content = (actual.readFileSync as typeof readFileSync)(p, ...rest)
      if (RACE.inject && typeof p === 'string' && p === RACE.journalPath && rest[0] === 'utf-8') {
        RACE.inject = false // 只注入一次（findUnsettled 单次读）
        actual.appendFileSync(
          p,
          JSON.stringify({
            opId: 'RACE-CONCURRENT-01',
            docId: 'doc_1',
            ts: new Date().toISOString(),
            status: 'pending',
            kind: 'move',
            oldPath: 'a.md',
            newPath: '写作/正文/concurrent.md',
          }) + '\n',
          'utf-8',
        )
      }
      return content
    }) as typeof readFileSync,
  }
})

import { appendAborted, appendMovePending, appendPending, appendSettled, findUnsettled, type JournalPending } from '../../src/document/journal.js'

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
    expect((u[0] as JournalPending).content).toBe('未结算')
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
    expect((u[0] as JournalPending).content).toBe(big + '尾巴')
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

  // ── KN-H-1（2026-08-23）：compact 读→替换窗口吞他进程 pending 的竞态守卫 ──

  it('KN-H-1: compact 读期间他进程追加 pending → 守卫弃本轮压缩，并发行不丢', () => {
    // 3 对 ASCII 结算对（每对 ~0.65MB）压在阈值下建仓，第 4 次 settle 跨阈值触发压缩
    const big = 'a'.repeat(650 * 1024)
    for (let i = 0; i < 3; i++) {
      const opId = appendPending(j, 'doc_1', null, big)
      appendSettled(j, opId, SHA(`sha256:pre${i}`))
    }
    expect(statSync(j).size).toBeLessThan(2 * 1024 * 1024) // 前置：未触发过早压缩
    const last = appendPending(j, 'doc_1', null, big) // ~2.6MB，跨阈值

    RACE.journalPath = j
    RACE.inject = true // 下一次 findUnsettled 读 journal 时注入他进程 append
    appendSettled(j, last, SHA('sha256:last')) // → maybeCompactJournal：读到追加前内容、盘上已多一行

    // 修复点：读后 stat 发现 size 变化 → 放弃压缩——并发行仍在盘上（原实现被整文件替换吞掉）
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('RACE-CONCURRENT-01')
    expect(text).toContain('写作/正文/concurrent.md')
    expect(statSync(j).size).toBeGreaterThan(2 * 1024 * 1024) // 未压缩（原文件原样保留）
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe('RACE-CONCURRENT-01')
  })

  it('KN-H-1: 无并发追加（守卫不发火）→ 压缩照常进行（守卫不误伤正常路径）', () => {
    const big = 'b'.repeat(650 * 1024)
    for (let i = 0; i < 3; i++) {
      const opId = appendPending(j, 'doc_1', null, big)
      appendSettled(j, opId, SHA(`sha256:quiet${i}`))
    }
    RACE.journalPath = j
    RACE.inject = false // mock 透传：读期间无他进程写
    const last = appendPending(j, 'doc_1', null, big)
    appendSettled(j, last, SHA('sha256:quiet-last')) // 触发压缩，守卫两 stat 一致 → 放行

    expect(statSync(j).size).toBe(0) // 全结算 → 压缩为空（原行为不变）
    expect(findUnsettled(j)).toHaveLength(0)
  })
})

// ── P3-10：move 类 pending（rename 与清单更新之间的崩溃窗口兜底）─────────

describe('journal move pending（P3-10）', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-move-'))
    j = join(dir, 'doc_1.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appendMovePending → findUnsettled 返回 move 形状（kind/oldPath/newPath）', () => {
    const opId = appendMovePending(j, 'doc_1', '写作/正文/1-a.md', '写作/正文/2-a.md')
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]).toMatchObject({ kind: 'move', oldPath: '写作/正文/1-a.md', newPath: '写作/正文/2-a.md' })
  })

  it('move pending 与 save pending 混合 → 各自独立配对结算', () => {
    const m = appendMovePending(j, 'doc_1', 'a.md', 'b.md')
    const s = appendPending(j, 'doc_1', null, '保存中')
    appendSettled(j, m, SHA('sha256:m1'))
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(s)
    appendAborted(j, s, '模拟失败')
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('损坏 move pending（缺 newPath）不救，findUnsettled 跳过', () => {
    appendFileSync(
      j,
      JSON.stringify({ opId: 'x', docId: 'd', ts: 't', status: 'pending', kind: 'move', oldPath: 'a.md' }) + '\n',
    )
    expect(findUnsettled(j)).toHaveLength(0)
  })
})
