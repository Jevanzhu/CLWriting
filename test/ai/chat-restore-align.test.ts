/**
 * msgSeqs 防御性对齐回归（第三轮复审低级项；第五轮修正方向）：prepareChatRun 检测到
 * msgSeqs 与 history 长度错位时，须尾部补齐/截尾对齐——清空（msgSeqs=[]）或前缀 unshift
 * 都会让后续 append 永久错位：finalizeHistory 的 trim 遮蔽 splice(0, cut) 拿到的将是
 * 「错误消息」的 seq（误遮蔽 → 重放里活消息隐身；漏遮 → 幽灵回归）。
 * 真实分歧方向（第五轮锚定）：「不足」的自然成因是回合 commit 点 flush 抛错——history
 * 已 push 而 seq 未追加，缺口必在尾部；前缀缺失无自然成因。
 */
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareChatRun } from '../../src/ai/orchestrate/chat/restore.js'
import { histories, msgSeqMap, activeBranchByBook } from '../../src/ai/orchestrate/chat/state.js'
import { makeDualTrackWorkdir, tempUserData } from '../studio/fixtures.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

const book = 'restore-align-test'
const dirs: string[] = []

afterEach(() => {
  histories.delete(book)
  msgSeqMap.delete(book)
  activeBranchByBook.delete(book)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeDriver(): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(): void {},
  }
}

describe('msgSeqs 防御性对齐（prepareChatRun）', () => {
  it('尾部缺（flush 抛错残留）→ 尾部补 []：既有 seq 与消息对齐不动，trim 遮蔽不误遮', () => {
    const workDir = makeDualTrackWorkdir()
    dirs.push(workDir, tempUserData())

    // 种子：history 3 条，msgSeqs 只有前 2 条的 seq——模拟回合 commit 点 flush 抛错
    // （history 已 push 本轮 user+assistant 而 seq 未追加 → 缺口在尾部）
    const history = histories.set(
      book,
      [
        { role: 'user', content: '旧1' },
        { role: 'assistant', content: '旧2' },
        { role: 'assistant', content: '旧3（seq 未知，flush 抛错残留）' },
      ],
    ).get(book)!
    msgSeqMap.set(book, [
      [10],
      [11],
    ])

    const prepared = prepareChatRun(
      { driver: makeDriver(), mainSession: { id: 's1', cwd: workDir, closed: false }, userDataPath: dirs[1]!, bookRoot: workDir, bookName: book, message: '新消息' },
      null, // mem 模式（store=null）——防御分支在此路径触发
      () => {},
    )

    // 对齐结果：尾部补 []（seq 未知的消息无可遮蔽），前两条 seq 原位保留——
    // 前缀 unshift 会错位成 [[], [10], [11]]，从此 10 声称属于旧2、11 属于旧3
    expect(msgSeqMap.get(book)).toEqual([[10], [11], []])
    expect(prepared.baseLen).toBe(3)

    // trim 模拟（finish.ts trimAndClose 同款）：裁掉最旧 1 条 → 遮蔽集合是旧1 的 [10]，
    // 对齐不破，剩余 msgSeqs 仍对应剩余 history
    const shadowSeqs = prepared.seqs.msgSeqs.splice(0, 1).flat()
    expect(shadowSeqs).toEqual([10])
    expect(prepared.seqs.msgSeqs).toEqual([[11], []])

    // 新回合消息经 commit 换算入账后追加对齐（history 4 条 = 3 旧 + 1 新 push）
    prepared.seqs.commitPendingMsgSeqs({ first: 100, last: 100 })
    expect(prepared.seqs.msgSeqs).toEqual([[11], [], [101]])
    expect(history.length).toBe(4)

    // 对照：旧实现①（清空）→ 后续 commit 全部相对错位；旧实现②（前缀 unshift）→
    // splice(0,1) 拿到 [] 而 [10] 留给已不存在的消息位——错位被固化
  })

  it('msgSeqs 超长（回合回滚残留）→ 截尾对齐：活消息 seq 保留、死 seq 丢弃', () => {
    const workDir = makeDualTrackWorkdir()
    dirs.push(workDir, tempUserData())
    // 场景：turn 内失败/中断 → finish 把 history 截回 baseLen=1，但已 commit 的
    // 第 2/3 条消息 seq 留在 msgSeqs 尾部（对应事件已被遮蔽 = 死 seq）
    histories.set(book, [{ role: 'user', content: '唯一存活' }])
    msgSeqMap.set(book, [
      [10],
      [21],
      [22],
    ])

    prepareChatRun(
      { driver: makeDriver(), mainSession: { id: 's1', cwd: workDir, closed: false }, userDataPath: dirs[1]!, bookRoot: workDir, bookName: book, message: 'x' },
      null,
      () => {},
    )

    // 截尾：保留 [10]（存活消息的 seq），丢弃死 seq [21]/[22]——截头会错位成 [22]
    expect(msgSeqMap.get(book)).toEqual([[10]])
  })
})
