/**
 * Y-1（第五十七轮）：ai-calls 旧格式迁移在记账写锁内的自锁回归。
 *
 * 缺陷：serializedWrite 空闲快路不设 writeChains——记账写持跨进程锁执行
 * recordTaskUsageLocked → readRecord 见旧格式再入 serializedWrite（快路）→
 * 对自持锁二次 acquire → Atomics.wait 同步自锁至超时 → 丢账 + 谎报「损坏」，
 * 文件永留旧格式（每次记账重复卡顿）；排队路径另有迁移写覆盖记账的姊妹窗口。
 *
 * 修复：锁内迁移直接内联 writeRecord（先迁移、记账叠加其上）。
 * 本文件用注入短锁超时（300ms）让缺陷形态快速显形：修复前本用例首查即
 * 卡 ≥300ms 且账目丢失；修复后瞬时完成 + 迁移 + 记账全落。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  recordTaskUsage,
  recordAiCall,
  __setAiCallsLockTimeoutForTest,
} from '../../src/ai/calls.js'

const root = mkdtempSync(join(tmpdir(), 'clwriting-calls-selflock-'))
beforeAll(() => {
  __setAiCallsLockTimeoutForTest(300)
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeOldFormat(bookRoot: string): void {
  mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  writeFileSync(
    join(bookRoot, '.cache', 'ai-calls.json'),
    JSON.stringify({ chapter: 5, used: 3, inputTokens: 100, outputTokens: 200 }),
  )
}

function readLedger(bookRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8')) as Record<string, unknown>
}

describe('ai-calls 旧格式迁移自锁（Y-1）', () => {
  it('记账写首触旧格式：锁内内联迁移——瞬时完成 + 迁移落盘 + 账目不丢', () => {
    const bookRoot = join(root, 'a')
    writeOldFormat(bookRoot)
    const t0 = Date.now()
    recordTaskUsage(bookRoot, 'chat', { inputTokens: 11, outputTokens: 22 })
    const elapsed = Date.now() - t0
    // 自锁形态（修复前）：同步阻塞 ≥ 注入超时 300ms 后丢账。修复后为文件 IO 级毫秒。
    expect(elapsed).toBeLessThan(250)
    const rec = readLedger(bookRoot) as {
      chapter: { num: number; used: number; inputTokens: number; outputTokens: number }
      tasks: Record<string, { used: number; inputTokens: number; outputTokens: number }>
    }
    // 迁移完成：chapter 已是新格式对象（旧 flat 值保留）
    expect(typeof rec.chapter).toBe('object')
    expect(rec.chapter.num).toBe(5)
    expect(rec.chapter.used).toBe(3)
    expect(rec.chapter.inputTokens).toBe(100)
    // 记账不丢（修复前：锁超时 → corrupt → 跳过记账）
    expect(rec.tasks['chat']).toBeDefined()
    expect(rec.tasks['chat']!.used).toBe(1)
    expect(rec.tasks['chat']!.inputTokens).toBe(11)
  })

  it('迁移后连续记账正常累计（排队路径无旧快照覆盖）', async () => {
    const bookRoot = join(root, 'b')
    writeOldFormat(bookRoot)
    // 同步背靠背两次：第一次走快路（内联迁移+记账），第二次排队为微任务
    recordTaskUsage(bookRoot, 'chat', { inputTokens: 1, outputTokens: 2 })
    recordTaskUsage(bookRoot, 'chat', { inputTokens: 1, outputTokens: 2 })
    await new Promise((r) => setTimeout(r, 50))
    const rec = readLedger(bookRoot) as {
      chapter: { num: number }
      tasks: Record<string, { used: number; inputTokens: number }>
    }
    expect(rec.chapter.num).toBe(5)
    expect(rec.tasks['chat']!.used).toBe(2)
    expect(rec.tasks['chat']!.inputTokens).toBe(2)
  })

  it('chapter 记账路径同治：recordAiCall 首触旧格式不丢章账', () => {
    const bookRoot = join(root, 'c')
    writeOldFormat(bookRoot)
    const t0 = Date.now()
    recordAiCall(bookRoot, 5, { inputTokens: 10, outputTokens: 20 })
    expect(Date.now() - t0).toBeLessThan(250)
    const rec = readLedger(bookRoot) as {
      chapter: { num: number; used: number; inputTokens: number }
    }
    expect(rec.chapter.num).toBe(5)
    // 旧值 3 + 本次 1
    expect(rec.chapter.used).toBe(4)
    expect(rec.chapter.inputTokens).toBe(110)
  })
})
