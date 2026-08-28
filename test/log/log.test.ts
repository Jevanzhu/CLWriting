/**
 * A4（批 0）结构化日志模块单测：队列串行 / 轮转清理 / err 序列化 /
 * 未初始化镜像 / 落盘失败降级（fail-open）。
 */
import { rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initLogging, log, resetLoggingForTest, flushLogsForTest, localDayKey } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
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
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
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
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: dir, mirrorConsole: false })
    log.error('pack', 'quiet')
    await flushLogsForTest()
    expect(errSpy).not.toHaveBeenCalled()
    expect(readLines()[0]!['msg']).toBe('quiet')
  })

  it('轮转清理：>7 天的日志文件启动即删，7 天内保留', async () => {
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
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
    const real = mkdtempTracked(join(tmpdir(), 'clw-log-real-'))
    dir = real
    // 占坑：把目录名先占住的是普通文件——appendFile 到 <file>/x 报 ENOTDIR
    const blocked = mkdtempTracked(join(tmpdir(), 'clw-log-block-'))
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
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    initLogging({ logsDir: dir })
    log.error('odd', 'weird value', 'plain string')
    await flushLogsForTest()
    const err = readLines()[0]!['err'] as { name: string; message: string }
    expect(err.name).toBe('string')
    expect(err.message).toBe('plain string')
  })

  it('幂等 init：重复调用不重复清理也不丢在途行', async () => {
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
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

  // D2 实施期回归（startup-notices 全量红根因）：换目录 init 与在途泵交错——
  // 首个 emit 已把泵排上 tail，随后 initLogging(新目录) 的 mkdir 链排在该泵之后；
  // 泵排空时 state.logsDir 已指向新目录（dayFile 在写入时取），旧实现 appendFile
  // 先于新目录 mkdir 执行 → ENOENT 降级丢行。修复 = 泵首幂等 mkdir 兜底。
  // 全量跑红 / 单跑绿的正是在途泵跨测试换目录的同型时序；此处用同步交错确定性复现。
  it('D2 实施期回归：泵先于新目录 mkdir 链执行的交错不丢行（泵首幂等 mkdir 兜底）', async () => {
    const dirA = mkdtempTracked(join(tmpdir(), 'clw-log-sw-'))
    const dirB = join(dirA, 'b') // 不预创建——目录创建是日志链的职责
    dir = dirA // afterEach 递归清理覆盖 dirB
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // 全同步序列（微任务未跑）：init(A) → emit → init(B) → emit
    initLogging({ logsDir: dirA, mirrorConsole: false })
    log.info('t', 'before-switch') // 泵 P 启动（排在 mkdirA/cleanupA 之后）
    initLogging({ logsDir: dirB, mirrorConsole: false }) // mkdirB 排在 P 之后
    log.info('t', 'after-switch') // pumping=true 直接入队，由 P 一并排空
    await flushLogsForTest()
    const now = new Date()
    const name = `app-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.jsonl`
    const raw = readFileSync(join(dirB, name), 'utf8')
    expect(raw).toContain('before-switch') // 旧行为：写向未建目录 ENOENT 降级丢行
    expect(raw).toContain('after-switch')
  })

  // M-6（第十轮）：第九轮 L-6 回归——dayFile 在 flush 时取日期。入队时取的话，
  // 23:59 入队、跨零点后才 flush 的行会写进前一天的 app-YYYYMMDD.jsonl（轮转
  // 边界错位）；修后行归属 flush 时所在日的文件，不串天
  it('M-6（第十轮）：第九轮 L-6——跨零点排队的日志行落次日文件（不串到前一天）', async () => {
    vi.useFakeTimers()
    try {
      dir = mkdtempTracked(join(tmpdir(), 'clw-log-'))
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

describe('log stdout-only 模式（阶段 22 批 U2 / U-5 单写者，S-3 + 二轮 F-4）', () => {
  afterEach(() => {
    delete process.env['CLW_LOG_STDOUT']
  })

  it('CLW_LOG_STDOUT=1：init 短路忽略 opts；emit 直写 stdout 同构 JSON 行；不镜像 console 不落盘', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-so-'))
    process.env['CLW_LOG_STDOUT'] = '1'
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => {
      writes.push(c)
      return true
    }) as never)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // opts 传 mirrorConsole:true 也应被短路忽略（stdout 即出口，镜像即双写）
    initLogging({ logsDir: dir, mirrorConsole: true })
    log.info('server', '监听就绪')
    log.error('http', '落库失败', new TypeError('disk full'))
    expect(writes).toHaveLength(2)
    const line1 = JSON.parse(writes[0]!.trim()) as Record<string, unknown>
    expect(line1).toMatchObject({ level: 'info', tag: 'server', msg: '监听就绪' })
    expect(typeof line1['ts']).toBe('string')
    const line2 = JSON.parse(writes[1]!.trim()) as Record<string, unknown>
    expect(line2['level']).toBe('error')
    expect(line2['tag']).toBe('http')
    // err 序列化形状与落盘行同构（main 侧 forwardLogLine 按 {name,message,stack} 重建）
    expect(line2['err']).toMatchObject({ name: 'TypeError', message: 'disk full' })
    expect(consoleSpy).not.toHaveBeenCalled()
    // F-4：短路不 mkdir 不落盘——目录保持空
    expect(readdirSync(dir)).toEqual([])
  })

  it('init 短路不跑 7 天清理：超期旧文件保留（正常模式会删）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clw-log-so2-'))
    writeFileSync(join(dir, 'app-20200101.jsonl'), '{"old":1}\n')
    process.env['CLW_LOG_STDOUT'] = '1'
    initLogging({ logsDir: dir, mirrorConsole: false })
    expect(existsSync(join(dir, 'app-20200101.jsonl'))).toBe(true)
  })
})
