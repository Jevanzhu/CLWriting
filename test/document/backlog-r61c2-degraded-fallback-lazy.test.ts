/**
 * R61-C-2（六十一轮）回归：appendPending 每笔保存无条件预构造降级行（全文 Buffer 拷贝白付）。
 *
 * 背景：degradedFallback（含 truncateSnapshotHeadTail 全文 UTF-8 Buffer 编码）在
 * 256KB 降级判定前无条件求值——常态（≤256KB，降级行几乎永不消费）每笔保存白付
 * 一次全文拷贝。修复：惰性化——降级行只在两处消费点（超阈值判定 / appendLineAsync
 * 锁超时降级兜底写）按需构造；常态零构造，超阈值与降级路径写出内容与修复前字节一致。
 *
 * 覆盖：
 * 1. 常态小文档保存 → 无全文级 Buffer.from(content)（修复前必发生 → 红）；
 * 2. 超阈值降级 → 降级行内容与修复前形态字节一致（头 21 山 + 标记 + 尾 22 山）；
 * 3. 锁超时降级（常态小快照）→ 惰性构造按需落盘，全文 + degraded:true 口径不变。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll, vi } from 'vitest'
import {
  appendPending,
  JOURNAL_PENDING_SNAPSHOT_MAX_BYTES,
  JOURNAL_PENDING_DEGRADED_KEEP_BYTES,
  JOURNAL_LOCK_TIMEOUT_MS,
  __setJournalDegradedKeepBytesForTest,
  __setJournalLockTimeoutForTest,
} from '../../src/document/journal.js'
import { initLogging, flushLogsForTest } from '../../src/log/index.js'

const dir = mkdtempSync(join(tmpdir(), 'clwriting-r61c2-'))
const logsDir = join(dir, 'logs')
// initLogging 的 mkdir 排在异步队列尾——锁超时 warn 可在 mkdir 完成前落盘（ENOENT
// 丢行），测试先行同步建目录（对齐 r53-journal-degraded-snapshot.test.ts 惯例）
mkdirSync(logsDir, { recursive: true })
initLogging({ logsDir, mirrorConsole: false })

afterAll(async () => {
  __setJournalDegradedKeepBytesForTest(JOURNAL_PENDING_DEGRADED_KEEP_BYTES)
  __setJournalLockTimeoutForTest(JOURNAL_LOCK_TIMEOUT_MS)
  await flushLogsForTest() // 日志队列排空后再删目录（防异步落盘与 rmSync 竞态丢行）
  rmSync(dir, { recursive: true, force: true })
})

/** 读 journal 文件内含 opId 的那一行并 JSON.parse */
function parseLine(journalPath: string, opId: string): { content: string; degraded?: boolean } {
  const line = readFileSync(journalPath, 'utf-8').split('\n').find((l) => l.includes(opId))
  expect(line).toBeDefined()
  return JSON.parse(line!) as { content: string; degraded?: boolean }
}

describe('R61-C-2：降级行惰性构造', () => {
  it('常态小文档保存（≤256KB）→ 不构造降级行（无全文级 Buffer.from(content) 白付），pending 行照常完整落盘', async () => {
    const jp = join(dir, 'normal.jsonl')
    const content = '正文内容'.repeat(200) // ≈1.6KB，常态
    expect(Buffer.byteLength(content, 'utf-8')).toBeLessThan(JOURNAL_PENDING_SNAPSHOT_MAX_BYTES)
    const fromSpy = vi.spyOn(Buffer, 'from')
    try {
      const opId = await appendPending(jp, 'doc-r61c2', null, content)
      // pending 行照常落盘（全文完整入 journal，行为不变）
      const parsed = parseLine(jp, opId)
      expect(parsed.degraded).toBeUndefined()
      expect(parsed.content).toBe(content)
      // 修复点：全程未对全文做 Buffer.from 编码（修复前 truncateSnapshotHeadTail
      // 无条件预构造降级行，必经 Buffer.from(content,'utf-8') 全文拷贝）
      const fullEncodes = fromSpy.mock.calls.filter(([arg]) => arg === content)
      expect(fullEncodes).toHaveLength(0)
    } finally {
      fromSpy.mockRestore()
    }
  })

  it('超阈值（>256KB）降级 → 降级行内容与修复前字节一致（头 21 山 + 同款标记 + 尾 22 山）', async () => {
    __setJournalDegradedKeepBytesForTest(64)
    const jp = join(dir, 'oversize.jsonl')
    const content = '山'.repeat(90_000) // 270KB > 256KB：超 256KB 降级闸（keep=64 只收敛截断预算）
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(JOURNAL_PENDING_SNAPSHOT_MAX_BYTES)
    const fromSpy = vi.spyOn(Buffer, 'from')
    try {
      const opId = await appendPending(jp, 'doc-r61c2', null, content)
      const parsed = parseLine(jp, opId)
      expect(parsed.degraded).toBe(true)
      // 修复前形态钉住：头 64B/尾 64B 按 UTF-8 切点收敛（21/22 个「山」）+ 同款标记文案——
      // 期望串独立推导（对齐 r53 切点算例），与修复前实现输出逐字节一致
      const expected =
        '山'.repeat(21) +
        '\n…〔快照超长已截断：中段 269871 字节未随行保存，全文以磁盘现状/版本历史为准〕…\n' +
        '山'.repeat(22)
      expect(parsed.content).toBe(expected)
      // 降级路径确实构造了（全文编码发生）
      expect(fromSpy.mock.calls.some(([arg]) => arg === content)).toBe(true)
    } finally {
      fromSpy.mockRestore()
      __setJournalDegradedKeepBytesForTest(JOURNAL_PENDING_DEGRADED_KEEP_BYTES)
    }
  })

  it('锁超时降级（常态小快照）→ 惰性构造的降级行按需落盘，内容与修复前一致（全文 + degraded:true）', async () => {
    __setJournalLockTimeoutForTest(50)
    const jp = join(dir, 'lock-timeout.jsonl')
    // 手工放置「活进程」锁（本进程 pid → 缺省探测恒存活）→ append 等锁超时走降级裸写
    writeFileSync(`${jp}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }), 'utf-8')
    try {
      const content = '正文开头一句话。' + '中'.repeat(2000) + '结尾最新键入。' // ≈6KB ≤ 2×KEEP
      const opId = await appendPending(jp, 'doc-r61c2', null, content)
      const parsed = parseLine(jp, opId)
      expect(parsed.degraded).toBe(true) // 降级形态口径不变
      expect(parsed.content).toBe(content) // 小快照原样保留（R53-D-2 口径不变）
    } finally {
      rmSync(`${jp}.lock`, { force: true })
    }
  })
})
