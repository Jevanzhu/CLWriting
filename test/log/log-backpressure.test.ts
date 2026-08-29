/**
 * D2（内存闸 2026-08-24 审计）回归：日志落盘队列背压上限。
 *
 * 原先 emit 每条日志往 state.tail 链一个 appendFile 闭包——磁盘挂起（appendFile
 * 长期 pending）时待写闭包无界线性累积。修复：显式待写队列（MAX_PENDING_WRITES
 * =1024）+ 单泵串行排空；超限丢最旧 + 周期性 warn 计数（慢盘场景内存有界优先于
 * 日志完备）。
 *
 * 可注入性：appendFile 经 vi.mock 换成受控闸（不 resolve 即磁盘挂起；释放后续写
 * 立即通过），其余 fs（mkdir/轮转清理）走真实现。独立文件承载 vi.mock——挂起
 * appendFile 会让共用文件的既有用例全部卡死。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initLogging,
  log,
  resetLoggingForTest,
  flushLogsForTest,
  debugLogQueueForTest,
  MAX_PENDING_WRITES,
} from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 受控闸（vi.hoisted：vi.mock 工厂提升后仍可引用）：appendFile 调用记录 + 挂起闸 */
const gate = vi.hoisted(() => {
  return {
    writes: [] as Array<{ file: string; data: string }>,
    promise: null as Promise<void> | null,
    resolve: null as (() => void) | null,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    appendFile: vi.fn(((file: string, data: string) => {
      gate.writes.push({ file, data })
      return gate.promise ?? Promise.resolve()
    }) as unknown as typeof real.appendFile),
  }
})

/** 磁盘挂起：此后 appendFile 全部 pending（已挂起的不受影响，须 release 才放行） */
function hangWrites(): void {
  gate.promise = new Promise<void>((r) => {
    gate.resolve = r
  })
}

/** 释放磁盘：挂起中的 appendFile 与后续调用全部放行 */
function releaseWrites(): void {
  gate.resolve?.()
}

let dir = ''

beforeEach(() => {
  gate.writes.length = 0
  gate.promise = null
  gate.resolve = null
})

afterEach(() => {
  resetLoggingForTest()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
  vi.restoreAllMocks()
})

describe('log 落盘队列背压（D2 内存闸 2026-08-24）', () => {
  it('慢盘（appendFile 永挂起）连续写超上限：队列封顶、最旧被丢、出现告警计数', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-bp-'))
    hangWrites()
    initLogging({ logsDir: dir, mirrorConsole: false })
    const total = MAX_PENDING_WRITES + 100
    for (let i = 0; i < total; i++) log.info('bp', `line-${i}`)
    // 同步断言（泵挂在首行 appendFile 上）：待写队列封顶，超出的 100 条最旧被丢——
    // 修复前这里是 pending=1124（tail 链闭包无界累积）
    expect(debugLogQueueForTest()).toEqual({ pending: MAX_PENDING_WRITES, dropped: 100 })
    // 告警计数出现：首次丢弃立即告警（消息带累计数）；同批后续丢弃被限频合并
    const warns = errSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('待写队列超限'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/累计 \d+ 条/)
    // 释放磁盘：泵排空幸存行——落盘从 line-100 起（line-0..99 已被丢），最新行在尾
    releaseWrites()
    await flushLogsForTest()
    const msgs = gate.writes.map((w) => (JSON.parse(w.data) as { msg: string }).msg)
    expect(msgs).toHaveLength(MAX_PENDING_WRITES)
    expect(msgs[0]).toBe('line-100')
    expect(msgs[msgs.length - 1]).toBe(`line-${total - 1}`)
    expect(msgs).not.toContain('line-0')
    expect(msgs).not.toContain('line-99')
    expect(debugLogQueueForTest()).toEqual({ pending: 0, dropped: 100 })
  })

  it('正常盘（不挂起）：串行顺序保持、无丢弃无告警（泵化不改既有语义）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-bp2-'))
    initLogging({ logsDir: dir, mirrorConsole: false })
    for (let i = 0; i < 50; i++) log.info('seq', `line-${i}`)
    await flushLogsForTest()
    const msgs = gate.writes.map((w) => (JSON.parse(w.data) as { msg: string }).msg)
    expect(msgs).toEqual(Array.from({ length: 50 }, (_, i) => `line-${i}`))
    expect(debugLogQueueForTest()).toEqual({ pending: 0, dropped: 0 })
    expect(errSpy).not.toHaveBeenCalled()
  })
})
