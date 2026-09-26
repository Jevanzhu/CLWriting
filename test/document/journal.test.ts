import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── KN-H-1（2026-08-23）/ N4（五十九轮）：compact 并发守卫确定性复现 ──
// 注入点落在「compact 已过锁内基线 stat、尚未 rename」的窗口内：经真实 appendFileSync
// 向 journal 追加 RACE.line，模拟他进程（锁超时降级裸写）在读算期间落下新行。
// R0916-7-P3-9（2026-09-25）：A-6 刀 1 的「尾段补追」随快照机制删除——并发口径回到
// N4「读算期间有变即整轮弃压」（原文件原样保留、新行随原文件在盘），故注入后断言
// 弃轮（文件仍超阈值且原文俱在），语义与 A-6 期相反，见 maybeCompactJournal 注释。
const RACE = vi.hoisted(() => ({ armed: false, journalPath: '', line: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // 注入点：compact 主读（scanUnsettled 的 readFileSync）返回「追加前」内容之后
    readFileSync: ((p, ...rest) => {
      const content = (actual.readFileSync as typeof readFileSync)(p, ...rest)
      if (RACE.armed && typeof p === 'string' && p === RACE.journalPath && rest[0] === 'utf-8') {
        RACE.armed = false // 一次性：一轮压缩只注入一次
        actual.appendFileSync(p, RACE.line, 'utf-8')
      }
      return content
    }) as typeof readFileSync,
  }
})

import {
  __setJournalCompactBytesForTest,
  appendAborted,
  appendMovePending,
  appendPending,
  appendSettled,
  findUnsettled,
  JOURNAL_COMPACT_BYTES,
} from '../../src/document/journal.js'

const SHA = (s: string) => s as `sha256:${string}`

afterEach(() => {
  RACE.armed = false
  RACE.line = ''
  RACE.journalPath = ''
})

describe('journal', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-'))
    j = join(dir, 'doc_1.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appendPending 返回 ULID opId，行含元数据（无全文快照字段）', async () => {
    const opId = await appendPending(j, 'doc_1', null)
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const line = readFileSync(j, 'utf-8').split('\n')[0]!
    expect(JSON.parse(line)).toEqual({
      opId,
      docId: 'doc_1',
      baseRevision: null,
      ts: expect.any(String),
      status: 'pending',
    })
    // R0916-7-P3-9：快照机制删除——实参内容不落盘（行即元数据全量）
    expect(line).not.toContain('正文内容')
    expect(line).not.toContain('content')
    expect(line).not.toContain('degraded')
  })

  it('pending + settled 配对 → findUnsettled 为空', async () => {
    const opId = await appendPending(j, 'doc_1', null)
    await appendSettled(j, opId, SHA('sha256:abc'))
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('pending 无 settled → findUnsettled 返回该条目', async () => {
    const opId = await appendPending(j, 'doc_1', null)
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(opId)
  })

  it('多 opId 混合 → 只返回未结算的', async () => {
    const a = await appendPending(j, 'doc_1', null)
    const b = await appendPending(j, 'doc_1', null)
    await appendSettled(j, a, SHA('sha256:1'))
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(b)
  })

  it('文件不存在 → findUnsettled 空', () => {
    expect(findUnsettled(join(dir, '无.jsonl'))).toHaveLength(0)
  })

  it('非法行跳过降级', async () => {
    await appendPending(j, 'doc_1', null)
    appendFileSync(j, '非法行\n{bad json\n')
    expect(findUnsettled(j)).toHaveLength(1)
  })
})

// ── U-P2-9：journal 膨胀压缩 ─────────────────────────

describe('journal compact（U-P2-9）', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-compact-'))
    j = join(dir, 'doc_1.jsonl')
    // compact 用例以注入低阈值 + 小内容建仓（生产阈值 2MB；afterEach 恢复常量防跨
    // describe 污染，R30-18 口径）。
    __setJournalCompactBytesForTest(1024)
  })
  afterEach(() => {
    __setJournalCompactBytesForTest(JOURNAL_COMPACT_BYTES)
    rmSync(dir, { recursive: true, force: true })
  })

  it('超阈值的全结算 journal → settle 后压缩为空文件', async () => {
    const big = '雪'.repeat(240) // 行以元数据为主，垫字节靠 docId 长度补齐
    for (let i = 0; i < 4; i++) {
      const opId = await appendPending(j, 'doc_' + big, null)
      await appendSettled(j, opId, SHA(`sha256:s${i}`))
    }
    expect(statSync(j).size).toBe(0) // 已结算行全部丢弃
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('压缩保留未结算 pending（崩溃检测资产不丢）', async () => {
    const pad = '雨'.repeat(200)
    const alive = await appendPending(j, 'doc_' + pad + '尾巴', null) // 未结算（快路径先行落盘）
    const settled1 = await appendPending(j, 'doc_' + pad, null)
    await appendSettled(j, settled1, SHA('sha256:a')) // 跨阈值 → 触发压缩
    const settled3 = await appendPending(j, 'doc_' + pad, null)
    await appendSettled(j, settled3, SHA('sha256:b')) // 二次触发（幂等）
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(alive)
  })

  it('阈值以下不压缩（防高频重写 O(n²)）', async () => {
    __setJournalCompactBytesForTest(1024 * 1024) // 显式高阈值：小文件不触发
    const opId = await appendPending(j, 'doc_1', null)
    await appendSettled(j, opId, SHA('sha256:c'))
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"pending"') // 原行保留
    expect(text).toContain('"status":"settled"')
  })

  it('aborted 配对同样参与压缩', async () => {
    const big = '风'.repeat(400) // ≈1.3KB > 阈值
    const opId = await appendPending(j, 'doc_' + big, null)
    await appendAborted(j, opId, '模拟磁盘满')
    expect(statSync(j).size).toBe(0)
    expect(findUnsettled(j)).toHaveLength(0)
  })

  // ── KN-H-1（2026-08-23）→ N4（五十九轮）：compact 与并发 append ──

  /** 建仓至超阈值：两对 settled 垫字节（每对 ~0.44KB，压在阈值下）→ 返回跨阈值的未结算 pending */
  async function seedCrossing(): Promise<string> {
    const big = 'a'.repeat(250)
    for (let i = 0; i < 2; i++) {
      const opId = await appendPending(j, 'doc_' + big, null)
      await appendSettled(j, opId, SHA(`sha256:pre${i}`))
    }
    expect(statSync(j).size).toBeLessThan(1024) // 前置：未触发过早压缩
    return await appendPending(j, 'doc_' + big, null) // 跨阈值（appendPending 不触发压缩）
  }

  /** KN-H-1/N4：compact 读→替换窗口吞他进程 pending 的竞态守卫——读算期间有新行即
   *  整轮弃压（R0916-7-P3-9 前的 A-6 尾段补追已随快照机制删除，回到 N4 口径）。
   *  注入口令见文件头 RACE 说明：本轮压缩后文件**不被替换**，因为盘上新行会被复核
   *  stat 抓到。 */
  it('N4: compact 主读期间他进程追加 pending → 弃本轮（原文与新增行俱在，settled 垫字节未清）', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.line =
      JSON.stringify({
        opId: 'RACE-CONCURRENT-01',
        docId: 'doc_1',
        ts: new Date().toISOString(),
        status: 'pending',
        kind: 'move',
        oldPath: 'a.md',
        newPath: '写作/正文/concurrent.md',
      }) + '\n'
    RACE.armed = true // 主读返回「追加前」内容 → 注入落在基线之后（before/after 复核窗口）
    await appendSettled(j, last, SHA('sha256:last')) // → maybeCompactJournal

    const text = readFileSync(j, 'utf-8')
    // 修复点①：并发行在盘（整文件替换若照做，它会随已结算垫字节一起被吞）
    expect(text).toContain('RACE-CONCURRENT-01')
    expect(text).toContain('写作/正文/concurrent.md')
    // 修复点②：本轮确实弃压（settled 垫字节原样保留、文件仍超阈值）
    expect(text).toContain('"status":"settled"')
    expect(statSync(j).size).toBeGreaterThanOrEqual(1024)
    // 崩溃检测面：新增行照常可被检出（settle 行已先落，last 不算未结算）
    expect(findUnsettled(j).map((p) => p.opId)).toEqual(['RACE-CONCURRENT-01'])
  })

  it('N4: 主读期间落下残行（无结尾 \\n）同样弃本轮，原文件与残行原文原样保留（不做任何拼接/截断）', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.line = '{"opId":"RACE-TORN-01","docId":"doc_1"' // 无结尾 \n：他进程写到一半
    RACE.armed = true
    await appendSettled(j, last, SHA('sha256:last'))

    const text = readFileSync(j, 'utf-8')
    expect(text.endsWith(RACE.line)).toBe(true) // 残行原文在盘（未被拼接进新文件、也未丢）
    expect(text).toContain('"status":"settled"') // 弃本轮：未压缩
    expect(statSync(j).size).toBeGreaterThanOrEqual(1024)
    expect(findUnsettled(j)).toEqual([]) // 残行被容错跳过（last 已 settle，不构成未结算）
  })

  it('KN-H-1: 无并发追加（守卫不发火）→ 压缩照常进行（守卫不误伤正常路径）', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.armed = false // 读期间无他进程写
    await appendSettled(j, last, SHA('sha256:quiet-last')) // 跨阈值触发压缩，复核两 stat 一致 → 放行

    expect(statSync(j).size).toBe(0) // 全结算 → 压缩为空（原行为不变）
    expect(findUnsettled(j)).toHaveLength(0)
  })
})

// ── P3-10：move 类 pending（rename 与清单更新之间的崩溃窗口兜底）─────────

describe('journal move pending（P3-10）', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-move-'))
    j = join(dir, 'doc_1.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appendMovePending → findUnsettled 返回 move 形状（kind/oldPath/newPath）', async () => {
    const opId = await appendMovePending(j, 'doc_1', '写作/正文/1-a.md', '写作/正文/2-a.md')
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]).toMatchObject({ kind: 'move', oldPath: '写作/正文/1-a.md', newPath: '写作/正文/2-a.md' })
  })

  it('move pending 与 save pending 混合 → 各自独立配对结算', async () => {
    const m = await appendMovePending(j, 'doc_1', 'a.md', 'b.md')
    const s = await appendPending(j, 'doc_1', null)
    await appendSettled(j, m, SHA('sha256:m1'))
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(s)
    await appendAborted(j, s, '模拟失败')
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
