import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, readFileSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── KN-H-1（2026-08-23）/ RC 源码重审 A-6（Opus-5.5 轮）：compact 跨进程竞态确定性复现 ──
// 注入点全部落在「compact 已过锁内基线 stat、尚未 rename」的窗口内（读→替换的裂缝），
// 由 RACE.stage 选档：
//  · 'read' —— compact 主读（scanUnsettled 的 readFileSync）读出「追加前」内容后，向文件
//              追加 RACE.line（KN-H-1 原始注入点）；
//  · 'tail' —— A-6 刀 1 的**后移注入点**：主读完成（readSeen 置位）后、对 journal 的首次
//              statSync 即尾段读窗起点——在此注入 RACE.line，模拟「基线之后、rename 之前」
//              他进程（锁超时降级裸写）落下新行，正是报告 A-6 指认的危险窗口本体。
//              RACE.line2 可选：在尾段首读过程中再注入一行，造「EOF 仍在增长 → 稳定性重读」。
// 注入一律经真实 appendFileSync 落盘。RACE.tornAppend：武装时把下一次对 journal 的
// appendFileSync 结尾换行截掉——模拟「写到一半被截断」的盘上末行（半行边界用例造态；
// 真实成因是崩溃/断电留下的残行）。
const RACE = vi.hoisted(() => ({
  stage: 'off' as 'off' | 'read' | 'tail',
  journalPath: '',
  line: '',
  line2: '',
  readSeen: false,
  tornAppend: false,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  /** 向 journal 追加原文（真实 fs，模拟他进程并发写） */
  const appendRaw = (p: string, text: string): void => {
    actual.appendFileSync(p, text, 'utf-8')
  }
  return {
    ...actual,
    // 'tail' 档注入点：主读之后的首次 stat = 尾段读窗起点（一次性）
    statSync: ((p: unknown, ...rest: unknown[]) => {
      if (RACE.stage === 'tail' && RACE.readSeen && typeof p === 'string' && p === RACE.journalPath) {
        RACE.stage = 'off'
        RACE.readSeen = false
        appendRaw(RACE.journalPath, RACE.line)
      }
      return (actual.statSync as (...a: unknown[]) => ReturnType<typeof statSync>)(p, ...rest)
    }) as unknown as typeof statSync,
    // 尾段首读（readByteRange 是模块内唯一 readSync 调用方）——可选二次注入
    readSync: ((fd: number, buf: unknown, off: number, len: number, pos: unknown) => {
      if (RACE.line2) {
        const second = RACE.line2
        RACE.line2 = ''
        appendRaw(RACE.journalPath, second)
      }
      return (actual.readSync as (...a: unknown[]) => number)(fd, buf, off, len, pos)
    }) as unknown as typeof readSync,
    appendFileSync: ((p: unknown, data: unknown, ...rest: unknown[]) => {
      if (RACE.tornAppend && p === RACE.journalPath && typeof data === 'string') {
        RACE.tornAppend = false // 只截断一次（造出残行后即恢复）
        return (actual.appendFileSync as (...a: unknown[]) => void)(p, data.slice(0, -1), ...rest)
      }
      return (actual.appendFileSync as (...a: unknown[]) => void)(p, data, ...rest)
    }) as unknown as typeof appendFileSync,
    readFileSync: ((p, ...rest) => {
      const content = (actual.readFileSync as typeof readFileSync)(p, ...rest)
      if (typeof p === 'string' && p === RACE.journalPath && rest[0] === 'utf-8') {
        if (RACE.stage === 'read') {
          RACE.stage = 'off' // 一次性：一轮压缩只注入一次
          appendRaw(p, RACE.line)
        } else if (RACE.stage === 'tail') {
          RACE.readSeen = true // 主读已完成 → 下一次 journal stat 即尾段读窗
        }
      }
      return content
    }) as typeof readFileSync,
  }
})

import { __setJournalCompactBytesForTest, appendAborted, appendMovePending, appendPending, appendSettled, findUnsettled, JOURNAL_COMPACT_BYTES, type JournalPending } from '../../src/document/journal.js'

const SHA = (s: string) => s as `sha256:${string}`

// A-6：注入状态逐用例复位（防跨用例串档）
afterEach(() => {
  RACE.stage = 'off'
  RACE.tornAppend = false
  RACE.readSeen = false
  RACE.line2 = ''
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

  it('appendPending 返回 ULID opId，文件含 pending + 全文', async () => {
    const opId = await appendPending(j, 'doc_1', null, '正文内容')
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"pending"')
    expect(text).toContain('正文内容')
  })

  it('pending + settled 配对 → findUnsettled 为空', async () => {
    const opId = await appendPending(j, 'doc_1', null, 'x')
    await appendSettled(j, opId, SHA('sha256:abc'))
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('pending 无 settled → findUnsettled 返回该条目（含全文快照）', async () => {
    await appendPending(j, 'doc_1', null, '未结算')
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect((u[0] as JournalPending).content).toBe('未结算')
  })

  it('多 opId 混合 → 只返回未结算的', async () => {
    const a = await appendPending(j, 'doc_1', null, 'a')
    const b = await appendPending(j, 'doc_1', null, 'b')
    await appendSettled(j, a, SHA('sha256:1'))
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(b)
  })

  it('文件不存在 → findUnsettled 空', () => {
    expect(findUnsettled(join(dir, '无.jsonl'))).toHaveLength(0)
  })

  it('非法行跳过降级', async () => {
    await appendPending(j, 'doc_1', null, 'x')
    appendFileSync(j, '非法行\n{bad json\n')
    expect(findUnsettled(j)).toHaveLength(1)
  })
})

// ── U-P2-9：journal 膨胀压缩（pending 含全文快照，日写线性涨）─────────

describe('journal compact（U-P2-9）', () => {
  let dir: string
  let j: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-compact-'))
    j = join(dir, 'doc_1.jsonl')
    // PM-3 批（性能与内存专项·2026-09-05）：pending 快照超 256KB 即降级（content:''），
    // MB 级全文撑破 2MB 阈值的旧建仓路径不复存在——compact 用例改走注入低阈值 + 小
    // 内容，压缩语义断言不变；afterEach 恢复常量防跨 describe 污染（R30-18 口径）。
    __setJournalCompactBytesForTest(1024)
  })
  afterEach(() => {
    __setJournalCompactBytesForTest(JOURNAL_COMPACT_BYTES)
    rmSync(dir, { recursive: true, force: true })
  })

  it('超阈值的全结算 journal → settle 后压缩为空文件', async () => {
    const big = '雪'.repeat(240) // 单条 pending ≈ 0.8KB
    for (let i = 0; i < 4; i++) {
      const opId = await appendPending(j, 'doc_1', null, big)
      await appendSettled(j, opId, SHA(`sha256:s${i}`))
    }
    expect(statSync(j).size).toBe(0) // 已结算行全部丢弃
    expect(findUnsettled(j)).toHaveLength(0)
  })

  it('压缩保留未结算 pending（崩溃恢复资产不丢）', async () => {
    const alive = await appendPending(j, 'doc_1', null, '雨'.repeat(200) + '尾巴') // 未结算（快路径先行落盘）
    const settled1 = await appendPending(j, 'doc_1', null, '雨'.repeat(100))
    await appendSettled(j, settled1, SHA('sha256:a')) // 跨阈值 → 触发压缩
    const settled3 = await appendPending(j, 'doc_1', null, '雨'.repeat(100))
    await appendSettled(j, settled3, SHA('sha256:b')) // 二次触发（幂等）
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe(alive)
    expect((u[0] as JournalPending).content).toBe('雨'.repeat(200) + '尾巴')
  })

  it('阈值以下不压缩（防高频重写 O(n²)）', async () => {
    __setJournalCompactBytesForTest(1024 * 1024) // 显式高阈值：小文件不触发
    const opId = await appendPending(j, 'doc_1', null, '小内容')
    await appendSettled(j, opId, SHA('sha256:c'))
    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"pending"') // 原行保留
    expect(text).toContain('"status":"settled"')
  })

  it('aborted 配对同样参与压缩', async () => {
    const big = '风'.repeat(400) // ≈1.3KB > 阈值
    const opId = await appendPending(j, 'doc_1', null, big)
    await appendAborted(j, opId, '模拟磁盘满')
    expect(statSync(j).size).toBe(0)
    expect(findUnsettled(j)).toHaveLength(0)
  })

  // ── KN-H-1（2026-08-23）→ RC 源码重审 A-6（Opus-5.5 轮）：compact 与并发 append ──

  /** 建仓至超阈值：两对 settled 垫字节（每对 ~0.44KB，压在阈值下）→ 返回跨阈值的未结算 pending */
  async function seedCrossing(): Promise<string> {
    const big = 'a'.repeat(250)
    for (let i = 0; i < 2; i++) {
      const opId = await appendPending(j, 'doc_1', null, big)
      await appendSettled(j, opId, SHA(`sha256:pre${i}`))
    }
    expect(statSync(j).size).toBeLessThan(1024) // 前置：未触发过早压缩
    return await appendPending(j, 'doc_1', null, big) // 跨阈值（appendPending 不触发压缩）
  }

  /** KN-H-1（2026-08-23）：compact 读→替换窗口吞他进程 pending 的竞态守卫。
   *  A-6（Opus-5.5 轮）起口径变更：原实现/原守卫此际「放弃本轮压缩」（文件继续超阈值，
   *  下次 settle 再撞同一窗口）；现由刀 1 尾段补追把该行**带进压缩后的新文件**——行不丢
   *  且文件确实被压缩，语义严格更强（原断言「未压缩（含已结算行）」不再成立）。 */
  it('KN-H-1/A-6: compact 主读期间他进程追加的 pending → 补追进压缩后文件（不再弃轮）', async () => {
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
    RACE.stage = 'read' // 主读返回「追加前」内容 → 注入落进基线之后（补追区间）
    await appendSettled(j, last, SHA('sha256:last')) // → maybeCompactJournal

    const text = readFileSync(j, 'utf-8')
    // 修复点①：并发行随压缩一并落盘（原实现被整文件替换吞掉）
    expect(text).toContain('RACE-CONCURRENT-01')
    expect(text).toContain('写作/正文/concurrent.md')
    // 修复点②：本轮确实压缩了（settled 垫字节全清）——A-6 前此处是「原文件原样保留」
    expect(text).not.toContain('"status":"settled"')
    expect(statSync(j).size).toBeLessThan(1024)
    const u = findUnsettled(j)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe('RACE-CONCURRENT-01')
  })

  it('A-6: 注入点后移到基线之后（尾段读窗，即报告 A-6 的危险窗口）→ 新行被补追进压缩后文件', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.line =
      JSON.stringify({
        opId: 'RACE-TAIL-01',
        docId: 'doc_1',
        ts: new Date().toISOString(),
        status: 'pending',
        kind: 'move',
        oldPath: 'a.md',
        newPath: '写作/正文/tail.md',
      }) + '\n'
    // 尾段首读过程中再落一行 → EOF 未稳 → 稳定性重读把两行一并补追（迭代上限内侧路）
    RACE.line2 =
      JSON.stringify({
        opId: 'RACE-TAIL-02',
        docId: 'doc_1',
        ts: new Date().toISOString(),
        status: 'pending',
        kind: 'move',
        oldPath: 'a.md',
        newPath: '写作/正文/tail2.md',
      }) + '\n'
    RACE.stage = 'tail'
    await appendSettled(j, last, SHA('sha256:last'))

    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('RACE-TAIL-01')
    expect(text).toContain('RACE-TAIL-02') // 证明走到了稳定性重读（单次读只会补追上第一行）
    expect(text).not.toContain('"status":"settled"') // 已压缩（补追不阻碍本轮压缩）
    expect(statSync(j).size).toBeLessThan(1024)
    expect(findUnsettled(j).map((p) => p.opId).sort()).toEqual(['RACE-TAIL-01', 'RACE-TAIL-02'])
  })

  // ── A-6 刀 1：尾段补追的半行边界（残行绝不拼进新文件）──

  it('A-6: 尾段落半行（注入行无结尾 \\n = 对端正写到一半）→ 弃本轮，原文件与残行原文原样保留', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.line = '{"opId":"RACE-TORN-01","docId":"doc_1"' // 无结尾 \n：半行
    RACE.stage = 'tail'
    await appendSettled(j, last, SHA('sha256:last'))

    const text = readFileSync(j, 'utf-8')
    expect(text).toContain('"status":"settled"') // 弃本轮：settled 垫字节未清（未压缩）
    expect(text.endsWith(RACE.line)).toBe(true) // 半行原文在盘（没被拼进新文件、也没被丢）
    expect(statSync(j).size).toBeGreaterThanOrEqual(1024)
  })

  it('A-6: 基线末行是残行（写入截断无 \\n）而其后又有新增 → 补追弃本轮（不得从半行中间切开拼接）', async () => {
    const last = await seedCrossing()
    const prefix = readFileSync(j, 'utf-8') // 触发前的文件内容（作为「原样保留」的对照）
    RACE.journalPath = j
    RACE.line =
      JSON.stringify({ opId: 'RACE-AFTER-TORN-01', docId: 'doc_1', ts: new Date().toISOString(), status: 'pending', kind: 'move', oldPath: 'a.md', newPath: '写作/正文/x.md' }) + '\n'
    RACE.stage = 'tail' // 新增行落在基线之后（尾段非空 → 才会走到行首校验）
    RACE.tornAppend = true // 触发行的追加被截断（无结尾 \n）→ 基线偏移处不落行首
    await appendSettled(j, last, SHA('sha256:last'))

    const text = readFileSync(j, 'utf-8')
    expect(text.startsWith(prefix)).toBe(true) // 原文件前缀原样保留
    expect(text.endsWith(RACE.line)).toBe(true) // 新增行原文在盘
    expect(text).toContain('"status":"settled"') // 弃本轮：未压缩
    // 残行尾巴与新行被并成同一条坏行（settled 行缺结尾 \n → 注入行直接贴在其 `}` 之后；
    // findUnsettled 容错跳过该坏行）——补追若从半行中间切开，新文件就会以一条来历不明的
    // 半截行开头。此断言同时钉住「弃轮的唯一可能成因就是不落行首」（尾段本身完整且以 \n
    // 收尾、读无失败、EOF 已稳，其余弃轮条件均不成立）
    expect(text).toContain('"newRevision":"sha256:last"}{"opId":"RACE-AFTER-TORN-01"')
  })

  it('A-6: 保留集 pending + 补追尾段落 settled（跨段抵消）→ findUnsettled 为空，行序保持「保留集在前」', async () => {
    const last = await seedCrossing() // 该 pending 在主读时仍未结算 → 进保留集
    RACE.journalPath = j
    RACE.line = JSON.stringify({ opId: last, ts: new Date().toISOString(), status: 'settled', newRevision: 'sha256:carry' }) + '\n'
    RACE.stage = 'read' // 主读之后才注入 → 保留集保留 pending，抵消靠补追尾段完成
    await appendSettled(j, last, SHA('sha256:last'))

    const text = readFileSync(j, 'utf-8')
    expect(text.indexOf('"status":"pending"')).toBeLessThan(text.indexOf('"status":"settled"')) // 保留集在前、尾段接后
    expect(statSync(j).size).toBeLessThan(1024) // 已压缩
    expect(findUnsettled(j)).toHaveLength(0) // 尾段的 settled 抵消掉保留集里的 pending
  })

  it('KN-H-1: 无并发追加（守卫不发火）→ 压缩照常进行（守卫不误伤正常路径）', async () => {
    const last = await seedCrossing()
    RACE.journalPath = j
    RACE.stage = 'off' // mock 透传：读期间无他进程写
    await appendSettled(j, last, SHA('sha256:quiet-last')) // 跨阈值触发压缩，守卫两 stat 一致 → 放行

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
    const s = await appendPending(j, 'doc_1', null, '保存中')
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
