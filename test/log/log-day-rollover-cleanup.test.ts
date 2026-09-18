/**
 * 0918二轮修复批（D101）：日志 7 天保留运行期清理回归——cleanupOldLogs 原先仅被
 * initLogging 启动期排队一次，长跑进程跨天新建的日志文件超期不清理（运行期目录
 * 无界增长）。修复：日志泵检测 dayFile 跨日切换时节流触发一次清理（src/process/
 * spill.ts sweepOldSpillsThrottled 同款 Map 节流，1h 窗）。
 *
 * 手法：vi.setSystemTime 注入时钟（dayFile 取本地 new Date、保留 cutoff 取
 * Date.now()，两者皆随假钟）；以「超期旧文件是否被删」作清理发生与否的行为证据——
 * 时钟回拨再前跳可在一小时内制造多次「跨日切换」，验节流只放行一次。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { flushLogsForTest, initLogging, log, resetLoggingForTest } from '../../src/log/index.js'

afterEach(() => {
  vi.useRealTimers()
  resetLoggingForTest()
})

/** 超期文件名（日期远早于任何 cutoff）——cleanupOldLogs 按文件名日期判超期 */
const STALE_NAME = 'app-20200101.jsonl'

describe('D101：跨日切换触发运行期清理', () => {
  it('运行期跨日：超期旧文件被删（修复前仅启动期清理一次，跨天后无人扫）', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'clw-log-roll-a-'))
    vi.useFakeTimers({ now: new Date(2026, 8, 10, 12, 0, 0) })
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.warn('roll', 'day1-line')
    await flushLogsForTest() // 启动期清理（init 排队）此刻已跑完
    expect(existsSync(join(dir, 'app-20260910.jsonl'))).toBe(true)
    expect(existsSync(join(dir, STALE_NAME))).toBe(false)

    // 启动清理之后才落进目录的超期文件——只有运行期清理能收走
    writeFileSync(join(dir, STALE_NAME), '{}\n', 'utf8')
    vi.setSystemTime(new Date(2026, 8, 11, 0, 5, 0)) // 跨本地零点
    log.warn('roll', 'day2-line')
    await flushLogsForTest()

    expect(existsSync(join(dir, 'app-20260911.jsonl'))).toBe(true) // 跨日新文件正常落盘
    expect(existsSync(join(dir, STALE_NAME))).toBe(false) // 超期文件被运行期清理收走
  })

  it('节流窗（1h）内多次切换只清一次：窗内再落的超期文件存活，窗外切换补清', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'clw-log-roll-b-'))
    const t0 = new Date(2026, 8, 10, 12, 0, 0)
    vi.useFakeTimers({ now: t0 })
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.warn('roll', 'base')
    await flushLogsForTest() // 首写建立 dayFile 基线（app-20260910）

    // 第一次切换（→ 0911）：真清一次（此刻无节流记录）
    writeFileSync(join(dir, STALE_NAME), '{}\n', 'utf8')
    vi.setSystemTime(new Date(2026, 8, 11, 12, 0, 0)) // t0 + 24h
    log.warn('roll', 'd2')
    await flushLogsForTest()
    expect(existsSync(join(dir, STALE_NAME))).toBe(false) // 清理 #1 已发生

    // 窗内第二次切换（回拨 → 0910）：切换被检测但节流拦下——再落的超期文件存活
    writeFileSync(join(dir, STALE_NAME), '{}\n', 'utf8')
    vi.setSystemTime(new Date(2026, 8, 10, 12, 30, 0)) // 清理 #1 后 30min < 1h 窗
    log.warn('roll', 'back')
    await flushLogsForTest()
    expect(existsSync(join(dir, 'app-20260910.jsonl'))).toBe(true) // 回拨日文件复用（切换真实发生）
    expect(existsSync(join(dir, STALE_NAME))).toBe(true) // 节流生效：窗内不清

    // 窗外第三次切换（→ 0911）：节流放行，补清
    vi.setSystemTime(new Date(2026, 8, 11, 13, 1, 0)) // 清理 #1 后 61min > 1h 窗
    log.warn('roll', 'd2-again')
    await flushLogsForTest()
    expect(existsSync(join(dir, STALE_NAME))).toBe(false) // 窗外切换补清
  })

  it('清理失败不影响日志主链：目录中途被删后跨日照常落盘（吞错语义）', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'clw-log-roll-c-'))
    vi.useFakeTimers({ now: new Date(2026, 8, 10, 12, 0, 0) })
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.warn('roll', 'day1')
    await flushLogsForTest()
    // 目录整个被外部删除：清理 readdir ENOENT（吞错），泵跨日时幂等 mkdir 重建
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
    vi.setSystemTime(new Date(2026, 8, 11, 0, 5, 0))
    log.warn('roll', 'day2-after-rm')
    await flushLogsForTest()
    expect(existsSync(join(dir, 'app-20260911.jsonl'))).toBe(true) // 主链未被清理失败拖垮
  })
})
