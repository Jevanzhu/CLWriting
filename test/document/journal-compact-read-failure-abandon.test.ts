/**
 * 五轮重评修复批（A101）回归：compact 读失败弃本轮压缩——journal 原文件保持，不得清空。
 *
 * 机理：maybeCompactJournal 原复用 findUnsettled 的 R61-C-1 读失败降级 []，把空集当
 * 「保留集」→ atomicWriteFile('') 把在档全部未结算 pending（崩溃恢复唯一依据，含全文
 * 快照）清空——读失败（EACCES/EBUSY 等）不触碰 size/mtime，N4 复核防线不触发，且
 * POSIX rename 只需目录写权、写权独立于读权，清空本可实际发生。修复后 compact 走
 * scanUnsettled 可辨信号，读失败整轮放弃（与 N4「有变即弃」同款 best-effort）。
 *
 * 手法：对齐 backlog-r61c1-read-fail-warn.test.ts 的 vi.mock node:fs 注入惯例
 * （vi.hoisted + importOriginal 透传，只劫持 journal 路径的单次 readFileSync）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const READFAIL = vi.hoisted(() => ({ inject: false, journalPath: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (READFAIL.inject && typeof p === 'string' && p === READFAIL.journalPath) {
        READFAIL.inject = false // 只注入一次（compact 内 scanUnsettled 单次读）
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { appendPending, appendSettled, findUnsettled, JOURNAL_COMPACT_BYTES } from '../../src/document/journal.js'
import { log } from '../../src/log/index.js'

describe('A101：compact 读失败弃本轮压缩（journal 不清空）', () => {
  let dir: string
  afterEach(() => {
    READFAIL.inject = false
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** 造超阈值 journal（settled 行垫字节 + 手写一条未结算 pending）。
   *  pending 行手写不经 appendPending——appendPending 尾部自带 maybeCompactJournal，
   *  会把垫字节先压掉，破坏「超阈值在盘」前提。 */
  function seedOversized(jp: string): string {
    let text = ''
    for (let i = 0; i < 200; i++) {
      text += `${JSON.stringify({ opId: `seed${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
    }
    while (text.length < JOURNAL_COMPACT_BYTES + 64 * 1024) text += text
    const keepOp = 'keep-op-1'
    text += `${JSON.stringify({ opId: keepOp, docId: 'doc_1', ts: 't', status: 'pending', baseRevision: null, content: '待恢复正文快照' })}\n`
    writeFileSync(jp, text, 'utf-8')
    return keepOp
  }

  it('读失败时的 compact 轮整轮放弃：文件仍超阈值且 pending 原文保持（原缺陷此际已被清空）', async () => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-a101-'))
    const jp = join(dir, 'doc_1.jsonl')
    const keepOp = seedOversized(jp)
    const warnSpy = vi.spyOn(log, 'warn')

    READFAIL.journalPath = jp
    READFAIL.inject = true
    // appendPending 不触发 compact（仅 settle/abort 后压缩）——注入保持武装，由
    // appendSettled 的 compact 轮消费（scanUnsettled 单次读）
    const done = await appendPending(jp, 'doc_1', null)
    await appendSettled(jp, done, 'sha256:done')

    // 修复点①：compact 弃本轮（warn 留痕），不拿空集当保留集清空文件
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('本轮压缩放弃'))).toBe(true)
    const after = readFileSync(jp, 'utf-8') // 注入已被 compact 消费，此处读为真读
    expect(after.length, '读失败清空 = 崩溃恢复依据全丢（原缺陷形态）').toBeGreaterThan(JOURNAL_COMPACT_BYTES)
    expect(after).toContain(keepOp) // 未结算 pending 原文保持

    // 修复点②：恢复扫描仍可找回该 pending；后续读成功的 settle 照常压缩且 pending 保留
    expect(findUnsettled(jp).map((p) => p.opId)).toContain(keepOp)
    const done2 = await appendPending(jp, 'doc_1', null)
    await appendSettled(jp, done2, 'sha256:done2')
    expect(findUnsettled(jp).map((p) => p.opId)).toEqual([keepOp])
  })

  it('读成功路径 compact 照常压缩（守卫不误伤正常压缩）', async () => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-a101-ok-'))
    const jp = join(dir, 'doc_1.jsonl')
    const keepOp = seedOversized(jp)
    const done = await appendPending(jp, 'doc_1', null)
    await appendSettled(jp, done, 'sha256:done')
    // 正常压缩后：settled 垫字节被清、未结算 pending 保留
    const after = readFileSync(jp, 'utf-8')
    expect(after.length).toBeLessThan(JOURNAL_COMPACT_BYTES)
    expect(after).toContain(keepOp)
    expect(findUnsettled(jp).map((p) => p.opId)).toEqual([keepOp])
  })
})
