/**
 * R0916-5b（2026-09-16）：server-manager.test.ts（1430 行）按 describe 域拆分件之一——
 * 「日志泵域」：批 U2 stdio 转发（§3.5 单写者 main 侧半边）与 forwardLogLine 解析
 * 口径纯函数直测、D1 splitLines 单行缓冲上限（纯函数 + manager 全链路接线）、
 * R50-A-4 exit 冲刷（纯函数 + 接线）。用例自原文件 591-789 行整块原样搬移
 * （describe/test 名称、断言、mock 行为零变化）；共享假件与装置见
 * ./server-manager-fixtures.js。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { forwardLogLine, splitLines, MAX_LINE_CHARS } from '../../src/desktop/server-manager.js'
import {
  mkHarness,
  mkUserData,
  mkLogCapture,
  flushMicrotasks,
  flushStreams,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'

describe('批 U2：stdio 转发（§3.5 单写者 main 侧半边）', () => {
  it('stdout JSON 行按 level/tag/msg 重发；err 透传重建 Error（F-3）', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write(
      JSON.stringify({ ts: '2026-08-23T00:00:00.000Z', level: 'info', tag: 'server', msg: '监听就绪' }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({
        ts: '2026-08-23T00:00:00.001Z',
        level: 'error',
        tag: 'http',
        msg: '落库失败',
        err: { name: 'SqliteError', message: 'disk full', stack: 'SqliteError: disk full\n  at db.run' },
      }) + '\n',
    )
    await flushStreams()
    expect(cap.lines[0]).toEqual({ level: 'info', tag: 'server', msg: '监听就绪' })
    expect(cap.lines[1]).toMatchObject({ level: 'error', tag: 'http', msg: '落库失败' })
    const err = cap.lines[1]!.err as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SqliteError')
    expect(err.message).toBe('disk full')
    expect(err.stack).toContain('SqliteError: disk full')
    await manager.stopChild()
  })

  it('跨 chunk 半行拼装 + 坏行/level 不可辨识/字段残缺原文兜底 + stderr 整行 warn', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    // 半行跨 chunk：切两段送达拼成一行
    const good = JSON.stringify({ level: 'info', tag: 'a', msg: 'm' })
    child.stdout.write(good.slice(0, 5))
    child.stdout.write(good.slice(5) + '\n')
    // 非 JSON 裸行（boot 期 console 直写等）：原文整行进档不吞
    child.stdout.write('Error: listen EADDRINUSE\n')
    // JSON 但 level 不可辨识：与坏行同口径
    child.stdout.write('{"level":"debug","tag":"x","msg":"y"}\n')
    // 字段残缺：tag/msg 非字符串 → 兜底 tag/原文 msg
    child.stdout.write('{"level":"info","tag":123}\n')
    // stderr（Node 警告/V8 诊断）：无 JSON 语义，整行 warn
    child.stderr.write('(node:12345) ExperimentalWarning: VM Modules\n')
    await flushStreams()
    expect(cap.lines.map((l) => [l.level, l.tag])).toEqual([
      ['info', 'a'],
      ['info', 'server-proc'],
      ['info', 'server-proc'],
      ['info', 'server-proc'],
      ['warn', 'server-proc'],
    ])
    expect(cap.lines[1]!.msg).toBe('Error: listen EADDRINUSE')
    expect(cap.lines[2]!.msg).toBe('{"level":"debug","tag":"x","msg":"y"}')
    expect(cap.lines[3]!.msg).toBe('{"level":"info","tag":123}')
    expect(cap.lines[4]!.msg).toBe('(node:12345) ExperimentalWarning: VM Modules')
    await manager.stopChild()
  })
})

describe('批 U2：forwardLogLine 解析口径（纯函数直测）', () => {
  it('warn 行无 err / err 非对象（字符串）→ 按无 err 处理不炸', () => {
    const cap = mkLogCapture()
    forwardLogLine(JSON.stringify({ level: 'warn', tag: 't', msg: 'm' }), cap.logger)
    forwardLogLine(JSON.stringify({ level: 'error', tag: 't', msg: 'm', err: 'boom' }), cap.logger)
    expect(cap.lines).toHaveLength(2)
    expect(cap.lines[0]).toMatchObject({ level: 'warn', tag: 't', msg: 'm' })
    expect(cap.lines[0]!.err).toBeUndefined()
    expect(cap.lines[1]!.err).toBeUndefined()
  })

  it('err 缺 message 字段（非完整形状）→ 按 undefined 处理', () => {
    const cap = mkLogCapture()
    forwardLogLine(JSON.stringify({ level: 'error', tag: 't', msg: 'm', err: { name: 'X' } }), cap.logger)
    expect(cap.lines[0]!.err).toBeUndefined()
  })
})

// ── D1（内存闸 2026-08-24 审计）：splitLines 单行缓冲上限 ──
// child 持续输出无换行内容（日志巨行 / \r 型进度条）时 buf 原先无界线性增长；
// 修复：超 1MB 强制截断出行 + 计数告警；带换行的正常行行为不变。
describe('D1: splitLines 单行缓冲上限（纯函数直测）', () => {
  it('超 1MB 无换行：强制截断出行（恰好 1MB）+ 计数告警；余量续入下一行', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const warns: number[] = []
    splitLines(
      out,
      (l) => lines.push(l),
      (n) => warns.push(n),
    )
    out.write('a'.repeat(MAX_LINE_CHARS + 50)) // 超 1MB 无换行（\r 型进度条同型）
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines[0]).toHaveLength(MAX_LINE_CHARS) // 截为恰好 1MB
    expect(lines[0]!).toBe('a'.repeat(MAX_LINE_CHARS))
    expect(warns).toEqual([1]) // 计数告警一次
    // 余量（总写入 - 1MB = 50）留在 buf 续累积：下一换行收口为正常行，不再告警
    out.write('\n')
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(lines[1]).toBe('a'.repeat(50))
    expect(warns).toEqual([1])
  })

  it('正常行不变：换行切分/跨 chunk 拼行/空行跳过口径保持，不触发告警', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const warns: number[] = []
    splitLines(
      out,
      (l) => lines.push(l),
      (n) => warns.push(n),
    )
    out.write('hello ')
    out.write('world\nsecond\n\n')
    await flushStreams()
    expect(lines).toEqual(['hello world', 'second']) // 跨 chunk 半行拼装 + 空行跳过不变
    expect(warns).toEqual([]) // 无超限不告警
  })
})

describe('D1: stdio 转发接线（manager 全链路）', () => {
  it('child stdout 巨量无换行 → 截断行原文兜底进档 + server-manager 计数告警', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write('x'.repeat(MAX_LINE_CHARS + 10)) // 非 JSON 巨行且无换行
    await vi.waitFor(() => {
      // 截断行（非 JSON）原文兜底进档：长度封在 1MB
      const forced = cap.lines.filter((l) => l.level === 'info' && l.tag === 'server-proc')
      expect(forced).toHaveLength(1)
      expect(forced[0]!.msg).toHaveLength(MAX_LINE_CHARS)
    })
    // 计数告警经注入 logger 落档（stdout 侧口径）
    const warns = cap.lines.filter((l) => l.level === 'warn' && l.tag === 'server-manager')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('stdout')
    expect(warns[0]!.msg).toContain('截断')
    await manager.stopChild()
  })
})

// ── R50-A-4（五十轮）：exit 冲刷残留半行 ──
// 子进程崩溃时尾行常无换行（最后诊断/堆栈恰卡半行），只挂 'data' 的切分缓冲随进程
// 死亡丢弃——恰是最关键取证线索。修复：splitLines 返回切分器句柄，forwardChildStdio
// 在 child exit 时对两路缓冲各强制冲刷一次再弃。
describe('R50-A-4: splitLines exit 冲刷（纯函数直测）', () => {
  it('半行残留经 flush() 出行；幂等（二次冲刷无产出）；冲后正常行口径不变', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const splitter = splitLines(out, (l) => lines.push(l))
    out.write('half line without newline') // 无换行：data 到达但不出行
    await flushStreams()
    expect(lines).toHaveLength(0)
    splitter.flush()
    expect(lines).toEqual(['half line without newline'])
    splitter.flush() // 幂等：缓冲已清，不重复出行
    expect(lines).toHaveLength(1)
    out.write('next\n') // 冲刷后正常换行行照常切分
    await flushStreams()
    expect(lines).toEqual(['half line without newline', 'next'])
  })
})

describe('R50-A-4: exit 冲刷接线（manager 全链路）', () => {
  it('主动停机（stopChild → kill → exit）：stdout/stderr 两路无换行尾行仍进日志', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write(JSON.stringify({ level: 'error', tag: 'boot', msg: 'half json line no newline' }))
    child.stderr.write('FATAL: heap out of memory') // 崩溃取证主线索形态：stderr 无换行尾行
    await flushStreams() // data 已入切分缓冲（无换行未出行）
    expect(cap.lines).toHaveLength(0) // 修复前形态锚定：无换行不出行
    await manager.stopChild() // kill → exit → 两路 flush
    const errLine = cap.lines.find((l) => l.level === 'error' && l.tag === 'boot')
    expect(errLine?.msg).toBe('half json line no newline') // stdout 半行 JSON 照常按 level 重发
    const stderrLine = cap.lines.find((l) => l.level === 'warn' && l.tag === 'server-proc')
    expect(stderrLine?.msg).toBe('FATAL: heap out of memory') // stderr 半行整行 warn 进档（修复前随进程死亡丢弃）
  })

  it('子进程崩溃（非主动 exit）：残留半行仍进日志；挂起重启被收口取消', async () => {
    const cap = mkLogCapture()
    // 大退避防 0ms 立即重启 fork 干扰断言（收尾 stopChild 取消挂起重启）
    const { forkRecords, manager } = mkHarness({ logger: cap.logger, backoffMs: [999_000, 999_000, 999_000] })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stderr.write('(node:4242) FATAL: segmentation fault')
    await flushStreams()
    child.emit('exit', 1) // 崩溃退出：exit 处理路径 flush
    await flushMicrotasks()
    expect(
      cap.lines.some(
        (l) => l.level === 'warn' && l.tag === 'server-proc' && l.msg === '(node:4242) FATAL: segmentation fault',
      ),
    ).toBe(true)
    await manager.stopChild() // 取消挂起重启（timer unref 不拖 worker，显式收口保净）
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
