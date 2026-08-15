/**
 * 历史压缩规划单测（批次 B1 / CS-7+CS-8，CLWriting 配对版）：
 * - groupIntoTurns：user(纯文本) 起点；assistant(tool_use)+user(tool_result) 同回合原子
 * - planCompaction：三分法切点不落回合中间；无物可压 → null
 * - compactHistory：no-op 引用透传 / 空摘要 fail-open / 严格更小校验 / 合并而非复制
 */
import { describe, it, expect } from 'vitest'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import { groupIntoTurns, planCompaction, compactHistory } from '../../src/ai/prompts/compaction.js'
import { CHECKPOINT_TAG_OPEN, CHECKPOINT_TAG_CLOSE, CHECKPOINT_PREAMBLE } from '../../src/ai/prompts/checkpoint.js'

const u = (t: string): ChatMsg => ({ role: 'user', content: t })
const a = (t: string): ChatMsg => ({ role: 'assistant', content: t })
/** assistant(tool_use) + user(tool_result) 配对（CLWriting 的 Anthropic 风格块结构） */
const toolPair = (id: string): ChatMsg[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'check_chapter', input: { chapter: 1 } }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: '机检全绿' }] },
]

describe('groupIntoTurns（配对版）', () => {
  it('纯文本往返：一问一答各成一回合的一半', () => {
    const msgs = [u('问1'), a('答1'), u('问2'), a('答2')]
    expect(groupIntoTurns(msgs)).toEqual([[u('问1'), a('答1')], [u('问2'), a('答2')]])
  })

  it('tool_use 与 tool_result 留在同一回合（切进中间 = Anthropic 400）', () => {
    const msgs = [u('查一下第1章'), a('我来看看'), ...toolPair('t1'), a('结论：没问题'), u('下一个问题'), a('好')]
    const turns = groupIntoTurns(msgs)
    expect(turns.length).toBe(2)
    // 第一回合 5 条：user + assistant(text) + assistant(tool_use) + user(tool_result) + assistant(text)
    expect(turns[0]!.length).toBe(5)
    expect(turns[0]!.at(-1)).toEqual(a('结论：没问题'))
    expect(turns[1]).toEqual([u('下一个问题'), a('好')])
  })

  it('连续多组 tool 配对仍在同回合；tool_result 的 user 不是新回合起点', () => {
    const msgs = [u('写第2章'), ...toolPair('t1'), ...toolPair('t2'), a('完成')]
    expect(groupIntoTurns(msgs).length).toBe(1)
  })

  it('首条非 user 悬空前缀自成一组（sanitizeHistory 正常会剔，此处不崩）', () => {
    const turns = groupIntoTurns([a('悬空'), u('问'), a('答')])
    expect(turns.length).toBe(2)
    expect(turns[0]).toEqual([a('悬空')])
  })

  it('空数组 → 无回合', () => {
    expect(groupIntoTurns([])).toEqual([])
  })
})

describe('planCompaction（三分法）', () => {
  it('回合数未超 keepTurns → null（无物可压）', () => {
    const msgs = [u('问1'), a('答1'), u('问2'), a('答2')]
    expect(planCompaction(msgs, { keepTurns: 10 })).toBeNull()
  })

  it('切点不落回合中间：toKeep 首条必是回合起点，toSummarize 含完整 tool 配对', () => {
    const msgs: ChatMsg[] = []
    for (let i = 1; i <= 12; i++) {
      msgs.push(u(`问${i}`))
      if (i === 1) msgs.push(...toolPair('t1'))
      msgs.push(a(`答${i}`))
    }
    const plan = planCompaction(msgs, { keepTurns: 10 })!
    expect(plan).not.toBeNull()
    // toSummarize = 回合1（user + tool 配对 2 条 + assistant = 4 条）+ 回合2（2 条）
    expect(plan.toSummarize.length).toBe(6)
    expect(plan.toSummarize[0]).toEqual(u('问1'))
    // 完整配对在待压区内（tool_use 与其 tool_result 同进 toSummarize）
    const types = plan.toSummarize.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.map((b) => b.type)))
    expect(types.filter((t) => t === 'tool_use').length).toBe(1)
    expect(types.filter((t) => t === 'tool_result').length).toBe(1)
    // toKeep 首条是回合起点（user 纯文本 = 问3）
    expect(plan.toKeep[0]).toEqual(u('问3'))
    expect(plan.toKeep.length).toBe(20)
  })
})

describe('compactHistory（纪律）', () => {
  const mkLong = (n: number): ChatMsg[] => {
    const out: ChatMsg[] = []
    for (let i = 1; i <= n; i++) out.push(u(`问题${i}${'细节'.repeat(50)}`), a(`回答${i}${'内容'.repeat(50)}`))
    return out
  }

  it('no-op：无物可压 → 原数组引用透传，summarize 不被调用', async () => {
    const history = mkLong(5)
    const out = await compactHistory(history, { keepTurns: 10 }, () => {
      throw new Error('不应调用')
    })
    expect(out.history).toBe(history)
    expect(out.summarizedCount).toBe(0)
    expect(out.overflow).toBe(false)
  })

  it('空摘要 fail-open：原数组引用返回，绝不插占位符', async () => {
    const history = mkLong(12)
    const out = await compactHistory(history, { keepTurns: 10 }, () => null)
    expect(out.history).toBe(history)
    expect(out.summarizedCount).toBe(0)
    expect(out.overflow).toBe(true)
  })

  it('严格更小校验：摘要不比原文小 → 视为失败（原引用返回）', async () => {
    const history = mkLong(12)
    const out = await compactHistory(history, { keepTurns: 10 }, () => '水'.repeat(10_000))
    expect(out.history).toBe(history)
    expect(out.summarizedCount).toBe(0)
  })

  it('成功：摘要以 user 消息插入（PREAMBLE + tag 包裹），toKeep 原样保留', async () => {
    const history = mkLong(12)
    const out = await compactHistory(history, { keepTurns: 10 }, () => '1. Primary Request and Intent（作者想推进第3卷）…')
    expect(out.summarizedCount).toBe(4) // 回合1+回合2 各 2 条
    expect(out.history).not.toBe(history)
    expect(out.history.length).toBe(1 + 20)
    const first = out.history[0]!
    expect(first.role).toBe('user')
    expect(typeof first.content === 'string' && first.content.startsWith(CHECKPOINT_PREAMBLE)).toBe(true)
    expect(first.content).toContain(CHECKPOINT_TAG_OPEN)
    expect(first.content).toContain(CHECKPOINT_TAG_CLOSE)
    expect(first.content).toContain('作者想推进第3卷')
    expect(out.history[1]).toEqual(history[4]) // toKeep 首条 = 回合3 的 user
  })

  it('合并而非复制：待压区首条已是先前存档 → 提取旧摘要传给摘要器', async () => {
    const prior = `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_TAG_OPEN}\n旧存档正文：第1卷已完结\n${CHECKPOINT_TAG_CLOSE}`
    const history: ChatMsg[] = [{ role: 'user', content: prior }]
    for (let i = 1; i <= 11; i++) history.push(u(`问题${i}${'细节'.repeat(50)}`), a(`回答${i}${'内容'.repeat(50)}`))
    let receivedPrior: string | null = 'unset'
    const out = await compactHistory(history, { keepTurns: 10 }, (_toSum, p) => {
      receivedPrior = p
      return '累计存档：第1卷已完结，第2卷进行中'
    })
    expect(receivedPrior).toBe('旧存档正文：第1卷已完结')
    expect(out.summarizedCount).toBe(3) // 旧存档消息 + 回合1（2 条）
    expect(out.history.length).toBe(1 + 20)
  })
})
