/**
 * IR-9（独立重评 2026-09-02）：日志泵「在途排空 × init 换目录」交错丢行根因回归——
 * 前一轮泵在途（pumping=true，不重启）时 initLogging 换目录 + 新行入队：在途泵继续
 * 排空时 state.logsDir 已指向新目录，而新目录此刻未建（init 的 mkdir 链排在本泵
 * 完成之后）→ appendFile ENOENT fail-open 静默丢行 + 空目录假象（startup-notices
 * 「日志同步落痕」全量偶红的根因；旧「泵首 mkdir」只做一次且目标是旧目录，兜不住
 * 此形态）。修复：泵内逐行盯目录，目标目录与上次落盘目录不符即幂等 mkdir。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flushLogsForTest, debugLogQueueForTest, initLogging, log, resetLoggingForTest } from '../../src/log/index.js'

const dirs: string[] = []

afterEach(() => {
  resetLoggingForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function readJsonl(dir: string): string {
  let text = ''
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    text += readFileSync(join(dir, f), 'utf8')
  }
  return text
}

describe('IR-9 日志泵换目录不丢行', () => {
  it('在途泵排空跨 init 换目录：零丢行，换目录后的行落新目录（旧实现 ENOENT 降级丢行）', async () => {
    // logsDir 本身不预建（真实形态：userData/logs 由 initLogging/pump 的 mkdir 链惰性
    // 创建）——预建目录会让旧实现的 ENOENT 丢行路径永不触发，测不到病灶
    const parentA = mkdtempSync(join(tmpdir(), 'clw-log-a-'))
    const parentB = mkdtempSync(join(tmpdir(), 'clw-log-b-'))
    const dirA = join(parentA, 'logs')
    const dirB = join(parentB, 'logs')
    dirs.push(parentA, parentB)

    // 800 行串行落盘（每行一次真实 fs 往返）把排空窗拉到几十 ms 量级：20ms 的等待
    // 落在「泵已起（首部仅 ~3 次 fs 往返）且远未排空」的窗口内——换目录必命中在途
    // 排空段。行数须 < MAX_PENDING_WRITES(1024)：超限触发 drop-oldest 背压（产品语义
    // = 内存有界优先），bulk 头部行会被合法丢弃与被测病灶无关，故本测禁触背压
    //（末尾 debugLogQueueForTest 锁 dropped===0）。旧实现：泵首 mkdir 只做一次且目标
    // = 旧目录 A，排空跨到新目录 B 时 init 的 mkdir 链还排在泵完成之后 →
    // appendFile(B) ENOENT fail-open **丢行**（startup-notices「日志同步落痕」全量
    // 偶红的根因）。修复后泵内逐行盯目录幂等 mkdir（对旧实现确定性红，见收口记）。
    initLogging({ logsDir: dirA, mirrorConsole: false })
    for (let i = 0; i < 800; i++) log.warn('race', `bulk-${i}`)
    await new Promise((r) => setTimeout(r, 20))
    initLogging({ logsDir: dirB, mirrorConsole: false })
    log.warn('race', 'switch-line')

    await flushLogsForTest()
    expect(debugLogQueueForTest().dropped).toBe(0) // 背压零触发：丢行只能是泵病灶
    const all = readJsonl(dirA) + readJsonl(dirB)
    for (let i = 0; i < 800; i++) expect(all).toContain(`bulk-${i}`)
    expect(all).toContain('switch-line')
    // 写时路由语义：换目录后入队的行落当前指向目录（dirB），不回写旧目录
    expect(readJsonl(dirA)).not.toContain('switch-line')
  })

  it('同一 tick 内连续多次换目录：零丢行（积压行按最后一次 init 目标目录落盘）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'clw-log-c-'))
    const dirB = mkdtempSync(join(tmpdir(), 'clw-log-d-'))
    dirs.push(dirA, dirB)

    // 三个 emit 与两次换目录在同一同步 tick 内完成——泵恢复排空时 state.logsDir 已是
    // 最后一次 init 的目标（D2 既有语义：积压行落「当前指向」目录，不按入队时目录归属）。
    // 本测锁的真实不变量 = 零丢行 + 每行落进某一已配置目录（泵内逐目录 mkdir 不 ENOENT）。
    initLogging({ logsDir: dirA, mirrorConsole: false })
    log.warn('race', 'first-to-any')
    await new Promise((r) => setTimeout(r, 0))
    initLogging({ logsDir: dirB, mirrorConsole: false })
    log.warn('race', 'mid-to-any')
    initLogging({ logsDir: dirA, mirrorConsole: false })
    log.warn('race', 'last-to-any')

    await flushLogsForTest()
    const all = readJsonl(dirA) + readJsonl(dirB)
    expect(all).toContain('first-to-any')
    expect(all).toContain('mid-to-any')
    expect(all).toContain('last-to-any')
  })
})
