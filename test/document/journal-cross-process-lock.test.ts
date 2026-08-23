/**
 * journal 跨进程锁回归（批次 J7）——compact 与 append 共享锁文件行为。
 *
 * 1. 锁被活进程持有（手工放置本进程 pid 的锁文件）→ maybeCompactJournal 弃本轮
 *    （不吞他进程在途 append 的 pending 行）；
 * 2. 同锁持有下 append 仍落盘（append 是崩溃恢复唯一依据，锁超时降级裸写 + warn）；
 * 3. 无锁竞争时 append → settled 触发 compact 正常压缩。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  appendPending,
  appendSettled,
  findUnsettled,
  JOURNAL_COMPACT_BYTES,
  __setJournalLockTimeoutForTest,
} from '../../src/document/journal.js'
import { readdirSync } from 'node:fs'
import { initLogging, flushLogsForTest } from '../../src/log/index.js'

const dir = mkdtempSync(join(tmpdir(), 'clwriting-journal-lock-'))
const logsDir = join(dir, 'logs')
initLogging({ logsDir, mirrorConsole: false })
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  __setJournalLockTimeoutForTest(2_000)
})

/** 读全部日志行（logsDir 下当日 JSONL） */
async function readLogLines(): Promise<{ tag: string; msg: string }[]> {
  await flushLogsForTest()
  const lines: { tag: string; msg: string }[] = []
  for (const f of readdirSync(logsDir)) {
    if (!f.endsWith('.jsonl')) continue
    for (const raw of readFileSync(join(logsDir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try {
        lines.push(JSON.parse(raw))
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return lines
}

/** 手工放置「活进程」锁（本进程 pid → 缺省探测恒存活） */
function holdLockWithOwnPid(journalPath: string): void {
  writeFileSync(`${journalPath}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }))
}

describe('journal 跨进程锁（J7）', () => {
  it('锁被活进程持有 → compact 弃本轮（文件原样保留），不误吞行', () => {
    __setJournalLockTimeoutForTest(50) // append 分支若误入等待路也不拖慢测试
    const jp = join(dir, 'compact-held.jsonl')
    // 造一个超阈值的 journal（settled 行占字节）
    let text = ''
    for (let i = 0; i < 200; i++) text += `${JSON.stringify({ opId: `op${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
    while (text.length < JOURNAL_COMPACT_BYTES + 1024) text += text
    writeFileSync(jp, text)
    const sizeBefore = readFileSync(jp, 'utf8').length
    holdLockWithOwnPid(jp)
    // appendSettled 会触发 maybeCompactJournal——锁被持 → 弃压缩
    appendSettled(jp, 'op-new', 'sha256:y')
    expect(readFileSync(jp, 'utf8').length).toBeGreaterThan(sizeBefore) // 只多了 append 行，未压缩
    rmSyncSafe(`${jp}.lock`)
  })

  it('锁被活进程持有 → append 仍落盘（降级裸写 + warn 留痕）', async () => {
    const jp = join(dir, 'append-held.jsonl')
    holdLockWithOwnPid(jp)
    const opId = appendPending(jp, 'doc-1', null, '正文内容')
    const lines = readFileSync(jp, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).opId).toBe(opId)
    expect(findUnsettled(jp).length).toBe(1)
    // 降级 warn 留痕（锁等待超时走了裸写分支）
    const logs = await readLogLines()
    expect(logs.some((l) => l.tag === 'journal' && l.msg.includes('降级裸写'))).toBe(true)
    rmSyncSafe(`${jp}.lock`)
  })

  it('无锁竞争 → append+settled 后 compact 正常压缩（无 pending 残留）', () => {
    const jp = join(dir, 'compact-normal.jsonl')
    let text = ''
    for (let i = 0; i < 200; i++) text += `${JSON.stringify({ opId: `op${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
    while (text.length < JOURNAL_COMPACT_BYTES + 1024) text += text
    writeFileSync(jp, text)
    const opId = appendPending(jp, 'doc-1', null, '快照')
    appendSettled(jp, opId, 'sha256:z')
    expect(readFileSync(jp, 'utf8').length).toBeLessThan(JOURNAL_COMPACT_BYTES)
    expect(findUnsettled(jp)).toEqual([])
    expect(existsSync(`${jp}.lock`)).toBe(false) // 锁用后清理
  })
})

function rmSyncSafe(p: string): void {
  rmSync(p, { force: true })
}
