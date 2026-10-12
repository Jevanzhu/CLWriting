/**
 * journal 跨进程面回归（批次 J7 + N4）——compact 与 append 共享锁文件行为，以及真双进程
 * 并发 append 下 compact 不吞他进程新行。
 *
 * 1. 锁被活进程持有（手工放置本进程 pid 的锁文件）→ maybeCompactJournal 弃本轮
 *    （不吞他进程在途 append 的 pending 行）；
 * 2. 同锁持有下 append 仍落盘（append 是崩溃恢复唯一依据，锁超时降级裸写 + warn）；
 * 3. 无锁竞争时 append → settled 触发 compact 正常压缩。
 * 4. N4：进程 A 在超阈值 journal 上高频 append+settle（每轮 settle 触发 compact 的
 *    读→算→整文件替换），进程 B 并发裸追加 pending 行（模拟锁超时降级裸写的 append
 *    路径）。终态 B 的全部 pending opId 必须仍可 findUnsettled 找回；静路径对照。
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
import { spawnNodeEval } from '../helpers/spawn-node.js'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  it('锁被活进程持有 → compact 弃本轮（文件原样保留），不误吞行', async () => {
    __setJournalLockTimeoutForTest(50) // append 分支若误入等待路也不拖慢测试
    const jp = join(dir, 'compact-held.jsonl')
    // 造一个超阈值的 journal（settled 行占字节）
    let text = ''
    for (let i = 0; i < 200; i++)
      text += `${JSON.stringify({ opId: `op${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
    while (text.length < JOURNAL_COMPACT_BYTES + 1024) text += text
    writeFileSync(jp, text)
    const sizeBefore = readFileSync(jp, 'utf8').length
    holdLockWithOwnPid(jp)
    // appendSettled 会触发 maybeCompactJournal——锁被持 → 弃压缩
    await appendSettled(jp, 'op-new', 'sha256:y')
    expect(readFileSync(jp, 'utf8').length).toBeGreaterThan(sizeBefore) // 只多了 append 行，未压缩
    rmSyncSafe(`${jp}.lock`)
  })

  it('锁被活进程持有 → append 仍落盘（降级裸写 + warn 留痕）', async () => {
    const jp = join(dir, 'append-held.jsonl')
    holdLockWithOwnPid(jp)
    const opId = await appendPending(jp, 'doc-1', null)
    const lines = readFileSync(jp, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).opId).toBe(opId)
    expect(findUnsettled(jp).length).toBe(1)
    // 降级 warn 留痕（锁等待超时走了裸写分支）
    const logs = await readLogLines()
    expect(logs.some((l) => l.tag === 'journal' && l.msg.includes('降级裸写'))).toBe(true)
    rmSyncSafe(`${jp}.lock`)
  })

  it('无锁竞争 → append+settled 后 compact 正常压缩（无 pending 残留）', async () => {
    const jp = join(dir, 'compact-normal.jsonl')
    let text = ''
    for (let i = 0; i < 200; i++)
      text += `${JSON.stringify({ opId: `op${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
    while (text.length < JOURNAL_COMPACT_BYTES + 1024) text += text
    writeFileSync(jp, text)
    const opId = await appendPending(jp, 'doc-1', null)
    await appendSettled(jp, opId, 'sha256:z')
    expect(readFileSync(jp, 'utf8').length).toBeLessThan(JOURNAL_COMPACT_BYTES)
    expect(findUnsettled(jp)).toEqual([])
    expect(existsSync(`${jp}.lock`)).toBe(false) // 锁用后清理
  })
})

function rmSyncSafe(p: string): void {
  rmSync(p, { force: true })
}

// ── compact 基线 stat 移入锁内 + rename 前重 stat 对比（真双进程行为级）。早期的
// 「尾段补追」已随快照机制撤除，复核口径回到「读算期间有新行即整轮弃压」——本组用例
// 的终态不变量（他进程行零丢失）与实现形态无关，两代口径下都应绿。──

const journalPath = fileURLToPath(new URL('../../src/document/journal.ts', import.meta.url))

/** 造超阈值 journal（settled 行灌字节） */
function seedOversizedForN4(jp: string): void {
  let text = ''
  for (let i = 0; i < 200; i++) {
    text += `${JSON.stringify({ opId: `seed${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
  }
  while (text.length < JOURNAL_COMPACT_BYTES + 64 * 1024) text += text
  writeFileSync(jp, text)
}

/** 起子进程跑脚本，resolve stdout（按行）——看门狗兜底防孤儿进程 */
function spawnWorker(script: string): Promise<string[]> {
  let out = ''
  return spawnNodeEval(script, { onStdout: (c) => (out += c) }).done.then(() => out.split('\n').filter((l) => l.trim()))
}

describe('N4 compact 与并发 append 互斥', () => {
  it('A 高频 append+settle（触发压缩）× B 并发 pending → B 的 pending 行零丢失', async () => {
    const jp = join(dir, 'n4-race.jsonl')
    seedOversizedForN4(jp)
    const mod = JSON.stringify(pathToFileURL(journalPath).href)
    const scriptA = `
import { appendPending, appendSettled } from ${mod}
const jp = ${JSON.stringify(jp)}
for (let i = 0; i < 60; i++) {
  const op = await appendPending(jp, 'docA', null)
  await appendSettled(jp, op, 'sha256:a' + i)
}
`
    const scriptB = `
import { appendPending } from ${mod}
const jp = ${JSON.stringify(jp)}
for (let i = 0; i < 40; i++) {
  const op = await appendPending(jp, 'docB', null)
  console.log(op)
}
`
    const [, bOps] = await Promise.all([spawnWorker(scriptA), spawnWorker(scriptB)])
    expect(bOps.length).toBe(40)
    // B 的全部 pending opId 必须可找回（compact 吞行 = 丢崩溃恢复依据）
    const unsettled = findUnsettled(jp)
    const ids = new Set(unsettled.map((p) => p.opId))
    for (const op of bOps) expect(ids.has(op)).toBe(true)
  }, 120_000)

  it('N4（静路径）：超阈值 journal 静置后单次 settle 仍正常压缩（守卫不误弃无竞争压缩）', async () => {
    const jp = join(dir, 'n4-quiet.jsonl')
    seedOversizedForN4(jp)
    // 留一个未结算 pending（压缩必须保留）；用另一个 op 的 settled 触发压缩
    const opA = await appendPending(jp, 'docC', null)
    const keep = await appendPending(jp, 'docC', null)
    await appendSettled(jp, opA, 'sha256:c')
    const unsettled = findUnsettled(jp)
    expect(unsettled.map((p) => p.opId)).toEqual([keep])
  })
})
