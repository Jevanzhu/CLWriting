/**
 * R53-D-2（五十三轮）回归：journal 降级行保留头尾截断快照（原 content:'' 剥离）。
 *
 * 背景：PM-3/R31-21 的降级行把快照整段剥离（content:''）——超 256KB 大章或锁超时
 * 降级后到下次成功保存之间崩溃，崩窗内新键入内容零盘上副本（版本历史只含已保存
 * 部分、磁盘是保存前旧文），「编辑永不静默丢失」红线在降级窗失守。修复后降级行
 * 经 truncateSnapshotHeadTail 保头（正文开头）尾（最新键入）各 32KB，行仍 ≤
 * 2×KEEP + 标记 ≈64KB（R31-21 的原子窗顾虑只在兆级行，PM-3 的 IO 翻倍动因不变）。
 *
 * 覆盖：
 * 1. 超限降级 → 头尾截断 + degraded:true，findUnsettled 字段校验兼容（content 仍
 *    合法 string），多字节字符切点安全（无 U+FFFD 残字）；
 * 2. 注入钩子收紧保留预算 → 头尾按字节精确收敛且不劈「山」（adjustBack 切点）；
 * 3. 锁超时降级（小快照）→ 全文保留不再无谓剥离（≤ 2×KEEP 原样，红线恢复）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  appendPending,
  findUnsettled,
  JOURNAL_PENDING_SNAPSHOT_MAX_BYTES,
  JOURNAL_PENDING_DEGRADED_KEEP_BYTES,
  __setJournalDegradedKeepBytesForTest,
  __setJournalLockTimeoutForTest,
} from '../../src/document/journal.js'
import { initLogging, flushLogsForTest } from '../../src/log/index.js'

const dir = mkdtempSync(join(tmpdir(), 'clwriting-r53-d2-'))
const logsDir = join(dir, 'logs')
// initLogging 的 mkdir 排在异步队列尾——锁超时 warn 可在 mkdir 完成前落盘（ENOENT
// 丢行），测试先行同步建目录
mkdirSync(logsDir, { recursive: true })
initLogging({ logsDir, mirrorConsole: false })

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  __setJournalDegradedKeepBytesForTest(JOURNAL_PENDING_DEGRADED_KEEP_BYTES)
  __setJournalLockTimeoutForTest(2_000)
})

/** 读 journal 文件内含 opId 的那一行并 JSON.parse */
function parseLine(journalPath: string, opId: string): { content: string; degraded?: boolean } {
  const line = readFileSync(journalPath, 'utf-8').split('\n').find((l) => l.includes(opId))
  expect(line).toBeDefined()
  return JSON.parse(line!) as { content: string; degraded?: boolean }
}

describe('R53-D-2：降级行头尾截断快照', () => {
  it('超限快照（>256KB）降级 → 头尾截断 + degraded:true，findUnsettled 兼容，多字节切点安全', async () => {
    const jp = join(dir, 'oversize.jsonl')
    // 中文正文（每字 3 字节）：头 32KB / 尾 32KB 的切点必落在多字节字符区，
    // 截断若有劈字符，读回内容会出现 U+FFFD 或断言失败
    const header = '---\n标题: 开篇\n---\n'
    const body = '夜风穿过窗缝，吹动桌角的手稿。'.repeat(20_000) // 15 字 ×3B ×2 万 ≈ 900KB
    const content = header + body
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(JOURNAL_PENDING_SNAPSHOT_MAX_BYTES)

    const opId = await appendPending(jp, 'doc-r53', null, content)
    const parsed = parseLine(jp, opId)
    expect(parsed.degraded).toBe(true)
    expect(parsed.content.startsWith(header)).toBe(true) // 头部 = 正文开头
    expect(parsed.content.endsWith('。')).toBe(true) // 尾部 = 最新键入（末字符完整）
    expect(parsed.content).toContain('快照超长已截断')
    expect(parsed.content).not.toContain('\uFFFD') // 无劈字符残字
    expect(parsed.content.length).toBeLessThan(40_000) // ≈2×32KB 字节 ≈ 2.2 万码元 + 标记，远小于原文

    // 恢复面契约：findUnsettled 照常识别（content 仍是合法 string，字段校验通过）
    const unsettled = findUnsettled(jp)
    expect(unsettled.map((p) => p.opId)).toContain(opId)
  })

  it('注入钩子收紧保留预算 → 头尾按字节精确收敛且不劈「山」（adjustBack 切点验证）', async () => {
    __setJournalDegradedKeepBytesForTest(64)
    const jp = join(dir, 'tiny-keep.jsonl')
    // 90 000 个「山」= 270KB > 256KB：注入钩子只收敛降级行截断预算，256KB 降级闸
    // （PM-3）不变——内容须同超两闸才落降级行
    const content = '山'.repeat(90_000)
    const opId = await appendPending(jp, 'doc-r53', null, content)
    const parsed = parseLine(jp, opId)
    expect(parsed.degraded).toBe(true)
    // 头：keep=64 落在第 22 个「山」（3B）的续字节 → 回退到 63 = 21 个「山」整
    // 尾：tailStart=270000-64=269936 落续字节 → 回退 269934 = 尾 22 个「山」整
    expect(parsed.content.startsWith('山'.repeat(21))).toBe(true)
    expect(parsed.content.endsWith('山'.repeat(22))).toBe(true)
    expect(parsed.content).toContain('269871 字节') // 中段 269934-63
    expect(parsed.content).not.toContain('\uFFFD')
    __setJournalDegradedKeepBytesForTest(JOURNAL_PENDING_DEGRADED_KEEP_BYTES) // 防泄漏后续用例
  })

  it('锁超时降级（小快照）→ 全文保留不再无谓剥离 + degraded:true + warn 留痕', async () => {
    __setJournalLockTimeoutForTest(50)
    const jp = join(dir, 'lock-timeout-small.jsonl')
    // 手工放置「活进程」锁（本进程 pid → 缺省探测恒存活）→ append 等锁超时走降级裸写
    writeFileSync(`${jp}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }))
    try {
      const content = '正文开头一句话。' + '中'.repeat(2000) + '结尾最新键入。' // ≈6KB ≤ 2×KEEP
      const opId = await appendPending(jp, 'doc-r53', null, content)
      const parsed = parseLine(jp, opId)
      expect(parsed.degraded).toBe(true) // 降级形态（R31-21 标记口径不变）
      expect(parsed.content).toBe(content) // 小快照原样保留（R53-D-2 前此处为 ''）
      expect(findUnsettled(jp).map((p) => p.opId)).toContain(opId)
      await flushLogsForTest()
      const logs = readdirSync(logsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => readFileSync(join(logsDir, f), 'utf8').split('\n'))
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { tag: string; msg: string })
      expect(logs.some((l) => l.tag === 'journal' && l.msg.includes('降级裸写'))).toBe(true)
    } finally {
      rmSync(`${jp}.lock`, { force: true })
    }
  })
})
