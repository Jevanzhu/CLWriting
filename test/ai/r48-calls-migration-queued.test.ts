/**
 * R48-2（四十八轮）回归：排队迁移写不得覆盖先行记账写落盘的账目。
 *
 * 场景（锁外读入队那半窗，Y-1 只消灭锁内嵌套入队那半）：写链被占时，记账写 A 先入队；
 * 锁外 read（checkAiCallBudget）见旧格式 → 迁移写 M 排在 A 后（调用序 = 落盘序）。
 * 放锁后 A 段内 readRecord 仍见旧格式 → 内联迁移 + 记账叠加落盘（新格式含账）；
 * M 随后执行——修复前写 enqueue 前的 migrated@T0 无账快照覆盖 A 刚落的账（丢账），
 * 修复后段内重读、仅当仍是旧格式才落盘。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkAiCallBudget, recordTaskUsage } from '../../src/ai/calls.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { waitFor as waitForShared } from '../helpers/wait-for.js'

const dirs: string[] = []
function tempBook(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-r48-calls-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONFIG = { budget: { calls_per_chapter: 3 } } as unknown as BookConfig
const OLD = (chapter: number): string =>
  JSON.stringify({ chapter, used: 2, inputTokens: 100, outputTokens: 200 }) + '\n'

/** 轮询等待文件满足判定（放锁后 A → M 依序微任务/异步轮询执行，无句柄可 await）。 */
const waitFor = (pred: () => boolean, timeoutMs = 2000) =>
  waitForShared(pred, timeoutMs, 10, 'waitFor 超时：队列写未在时限内落盘')

describe('R48-2: 排队迁移写不覆盖先行记账写', () => {
  it('[A, M] 队列序下 task 账目保留（修复前被 T0 快照覆盖）', async () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), OLD(5))

    // 占住 calls 写段的同一把锁 → 后续记账写/迁移写都进 writeChains 排队
    const lockPath = join(root, '.cache', 'ai-calls.json.lock')
    const release = await acquireCrossProcessLockAsync(lockPath, 5_000)
    expect(release).toBeTruthy()
    try {
      // A：记账写先入队（锁被占 → writeWithCrossProcessLock 返回在途 promise）
      recordTaskUsage(root, 'outline', { inputTokens: 11, outputTokens: 22 })
      // M：锁外 read 见旧格式 → 迁移写排在 A 后（migratedRoots 标记防重复入队）
      const b = checkAiCallBudget(root, 5, CONFIG)
      expect(b.ok).toBe(true)
      if (b.ok) expect(b.used).toBe(2) // 旧格式账照常读出
    } finally {
      release!()
    }

    // 放锁后 A 执行：段内 inWriteSegment=true，readRecord 见旧格式 → 内联迁移 + 记账落盘
    const recPath = join(root, '.cache', 'ai-calls.json')
    await waitFor(() => {
      const rec = JSON.parse(readFileSync(recPath, 'utf8')) as {
        chapter: unknown
        tasks?: Record<string, unknown>
      }
      return typeof rec.chapter === 'object' && rec.tasks?.['outline'] !== undefined
    })
    // 再让 M 出队执行完（同一链上紧随 A）
    await new Promise((r) => setTimeout(r, 50))

    // 修复前：M 写 T0 无账快照 → tasks.outline 消失（丢账）；修复后段内重读见新格式跳过
    const rec = JSON.parse(readFileSync(recPath, 'utf8')) as {
      chapter: { used: number; inputTokens: number }
      tasks: Record<string, { used: number; inputTokens: number }>
    }
    expect(rec.tasks['outline']?.used).toBe(1)
    expect(rec.tasks['outline']?.inputTokens).toBe(11)
    // A 段内内联迁移把旧格式 chapter 账带过来了（used=2/100/200），M 覆盖会回退到它
    // 丢失 tasks——chapter.used 同时断言可区分「M 覆盖」与「M 跳过」两形态
    expect(rec.chapter.used).toBe(2)
    expect(rec.chapter.inputTokens).toBe(100)
  })

  it('迁移写执行时文件已是新格式 → 不落盘、不抛（幂等跳过路径）', async () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), OLD(5))

    const lockPath = join(root, '.cache', 'ai-calls.json.lock')
    const release = await acquireCrossProcessLockAsync(lockPath, 5_000)
    expect(release).toBeTruthy()
    try {
      // 触发迁移写入队（此时文件是旧格式）
      const b = checkAiCallBudget(root, 5, CONFIG)
      expect(b.ok).toBe(true)
      // 入队后、执行前，外部把文件写成新格式（模拟先行写已迁移落盘）
      const migrated = {
        chapter: { num: 5, used: 7, inputTokens: 700, outputTokens: 1400 },
        tasks: {},
      }
      writeFileSync(join(root, '.cache', 'ai-calls.json'), JSON.stringify(migrated, null, 2) + '\n')
    } finally {
      release!()
    }
    // 等 M 出队：跳过路径不改文件（若误写会回退成 T0 迁移态 used=2）
    await new Promise((r) => setTimeout(r, 50))
    const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')) as {
      chapter: { used: number }
    }
    expect(rec.chapter.used).toBe(7) // 外部新格式未被 T0 快照回写
  })
})
