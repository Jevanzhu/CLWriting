/**
 * A4（批 0）结构化日志模块单测：队列串行 / 轮转清理 / err 序列化 /
 * 未初始化镜像 / 落盘失败降级（fail-open）。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initLogging, log, resetLoggingForTest, flushLogsForTest } from '../../src/log/index.js'

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
})
