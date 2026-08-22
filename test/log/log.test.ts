/**
 * A4（批 0）结构化日志模块单测：队列串行 / 轮转清理 / err 序列化 /
 * 未初始化镜像 / 落盘失败降级（fail-open）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initLogging, log, resetLoggingForTest, flushLogsForTest, localDayKey } from '../../src/log/index.js'

let dir = ''

afterEach(() => {
  resetLoggingForTest()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
  vi.restoreAllMocks()
})

/** 当天日志文件内容按行解析 */
function readLines(): Array<Record<string, unknown>> {
  const now = new Date()
  const name = `app-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.jsonl`
  const raw = readFileSync(join(dir, name), 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('log 模块（A4 批 0）', () => {
  it('localDayKey：按本地日切日（成本/trace 分桶与日志文件日同口径，M2 二轮复审）', () => {
    // UTC 2026-08-20T20:00Z = 东八区 8-21 04:00 —— UTC 切日记 08-20，本地日应记 08-21。
    // 断言用 Date 的本地分量构造期望，测试在任何时区都成立（不写死偏移）
    const ts = Date.UTC(2026, 7, 20, 20, 0, 0)
    const d = new Date(ts)
    const expectKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(localDayKey(ts)).toBe(expectKey)
    expect(localDayKey(new Date(ts))).toBe(expectKey) // Date 入参同口径
    expect(localDayKey(new Date(ts).toISOString())).toBe(expectKey) // ISO 字符串同口径
    // 与日志文件名同一天（app-YYYYMMDD ↔ YYYY-MM-DD）
    expect(localDayKey(Date.now()).replaceAll('-', '')).toMatch(/^\d{8}$/)
  })

  it('未初始化：仅镜像 console，不落盘（与引入前行为一致）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.error('t1', 'boom')
    log.warn('t1', 'careful')
    expect(errSpy).toHaveBeenCalledWith('[t1] boom')
    expect(warnSpy).toHaveBeenCalledWith('[t1] careful')
    // logsDir 为 null：不排队、不落盘（flush 是空操作也不产生文件）
    expect(flushLogsForTest()).resolves.toBeUndefined()
  })

  it('初始化后：JSONL 落盘 + 镜像 console；行含 {ts,level,tag,msg,err}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: dir })
    const e = new Error('disk on fire')
    log.error('api', '落盘失败（章 3）', e)
    await flushLogsForTest()
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!['level']).toBe('error')
    expect(lines[0]!['tag']).toBe('api')
    expect(lines[0]!['msg']).toBe('落盘失败（章 3）')
    expect(typeof lines[0]!['ts']).toBe('string')
    const err = lines[0]!['err'] as { name: string; message: string; stack?: string }
    expect(err.name).toBe('Error')
    expect(err.message).toBe('disk on fire')
    expect(typeof err.stack).toBe('string')
    expect(errSpy).toHaveBeenCalled() // 镜像保持
  })

  it('串行队列：连续写入保持调用序（行序 = 调用序）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    initLogging({ logsDir: dir, mirrorConsole: false })
    for (let i = 0; i < 50; i++) log.info('seq', `line-${i}`)
    await flushLogsForTest()
    const lines = readLines()
    expect(lines).toHaveLength(50)
    lines.forEach((l, i) => expect(l['msg']).toBe(`line-${i}`))
  })

  it('mirrorConsole=false：打包态不镜像', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.error('pack', 'quiet')
    await flushLogsForTest()
    expect(errSpy).not.toHaveBeenCalled()
    expect(readLines()[0]!['msg']).toBe('quiet')
  })

  it('轮转清理：>7 天的日志文件启动即删，7 天内保留', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const old = new Date(Date.now() - 9 * 24 * 3600 * 1000)
    const oldName = `app-${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, '0')}${String(old.getDate()).padStart(2, '0')}.jsonl`
    const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const recentName = `app-${recent.getFullYear()}${String(recent.getMonth() + 1).padStart(2, '0')}${String(recent.getDate()).padStart(2, '0')}.jsonl`
    writeFileSync(join(dir, oldName), '{}\n')
    writeFileSync(join(dir, recentName), '{}\n')
    writeFileSync(join(dir, 'not-a-log.txt'), 'x')
    initLogging({ logsDir: dir, mirrorConsole: false })
    await flushLogsForTest()
    expect(existsSync(join(dir, oldName))).toBe(false)
    expect(existsSync(join(dir, recentName))).toBe(true)
    expect(existsSync(join(dir, 'not-a-log.txt'))).toBe(true) // 非日志文件不碰
  })

  it('fail-open：落盘失败（目录被换成名同文件）降级 console，不抛出、队列不断', async () => {
    const real = mkdtempSync(join(tmpdir(), 'clw-log-real-'))
    dir = real
    // 占坑：把目录名先占住的是普通文件——appendFile 到 <file>/x 报 ENOTDIR
    const blocked = mkdtempSync(join(tmpdir(), 'clw-log-block-'))
    rmSync(blocked, { recursive: true, force: true })
    writeFileSync(blocked, 'not a dir')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: blocked, mirrorConsole: false })
    expect(() => log.error('io', 'first')).not.toThrow()
    await flushLogsForTest()
    // 第二条仍安全（队列未断、未熔断）
    expect(() => log.error('io', 'second')).not.toThrow()
    await flushLogsForTest()
    rmSync(blocked, { force: true })
  })

  it('非 Error 值收编为 {name,message} 字符串形状', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: dir })
    log.error('odd', 'weird value', 'plain string')
    await flushLogsForTest()
    const err = readLines()[0]!['err'] as { name: string; message: string }
    expect(err.name).toBe('string')
    expect(err.message).toBe('plain string')
  })

  it('幂等 init：重复调用不重复清理也不丢在途行', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.info('a', 'before-reinit')
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.info('b', 'after-reinit')
    await flushLogsForTest()
    const msgs = readLines().map((l) => l['msg'])
    expect(msgs).toContain('before-reinit')
    expect(msgs).toContain('after-reinit')
  })

  // M-6（第十轮）：第九轮 L-6 回归——dayFile 在 flush 时取日期。入队时取的话，
  // 23:59 入队、跨零点后才 flush 的行会写进前一天的 app-YYYYMMDD.jsonl（轮转
  // 边界错位）；修后行归属 flush 时所在日的文件，不串天
  it('M-6（第十轮）：第九轮 L-6——跨零点排队的日志行落次日文件（不串到前一天）', async () => {
    vi.useFakeTimers()
    try {
      dir = mkdtempSync(join(tmpdir(), 'clw-log-'))
      vi.spyOn(console, 'log').mockImplementation(() => {})
      // 23:59 入队（init 的 mkdir/清理队列先排空，保证日志行入队后队列首动作就是它的 flush）
      vi.setSystemTime(new Date(2026, 7, 21, 23, 59, 0))
      initLogging({ logsDir: dir, mirrorConsole: false })
      await flushLogsForTest()
      log.info('rot', '跨零点行')
      // 模拟在途写/微任务延迟把 flush 拖过零点
      vi.setSystemTime(new Date(2026, 7, 22, 0, 0, 30))
      await flushLogsForTest()
      // 行归属 flush 时的日期文件（次日）；前一天文件不出现——入队时取日期的旧行为会落前一天
      const nextDay = 'app-20260822.jsonl'
      const prevDay = 'app-20260821.jsonl'
      expect(existsSync(join(dir, nextDay))).toBe(true)
      expect(readFileSync(join(dir, nextDay), 'utf8')).toContain('跨零点行')
      expect(existsSync(join(dir, prevDay))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
