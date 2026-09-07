/**
 * R61-C-1（六十一轮）回归：journal 文件级读失败静默零留痕。
 *
 * 背景：findUnsettled 对「journal 在盘但读取失败」（EACCES/EBUSY 等异常）走空体
 * catch 直接返回 []——崩溃恢复扫描静默归零，作者对丢字风险零感知且无诊断线索。
 * 修复：catch 内补 log.warn（对齐同链路 state.ts R54-B-1 循环级 warn 口径），
 * 降级语义不变（仍返回 []，不阻断进门），但失败必留痕（含路径与错误信息）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'

// ── mock node:fs：注入开启且路径命中时 readFileSync 抛 EACCES（journal 在盘但不可读）──
// 组织方式对齐 journal.test.ts 的 RACE 注入惯例（vi.hoisted + importOriginal 透传）。
const READFAIL = vi.hoisted(() => ({ inject: false, journalPath: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (READFAIL.inject && typeof p === 'string' && p === READFAIL.journalPath) {
        READFAIL.inject = false // 只注入一次（findUnsettled 单次读）
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { findUnsettled } from '../../src/document/journal.js'
import { log } from '../../src/log/index.js'

describe('R61-C-1：journal 文件级读失败 warn 留痕', () => {
  let dir: string
  afterEach(() => {
    READFAIL.inject = false
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('journal 在盘但读取失败 → log.warn 留痕（含 journalPath 与错误信息）且仍降级返回 []', () => {
    dir = mkdtempSync(join(tmpdir(), 'journal-r61c1-'))
    const jp = join(dir, 'doc_1.jsonl')
    writeFileSync(jp, '{"status":"pending","opId":"x"}\n', 'utf-8') // 在盘（existsSync 探测通过）
    const warnSpy = vi.spyOn(log, 'warn')

    READFAIL.journalPath = jp
    READFAIL.inject = true
    const u = findUnsettled(jp)

    expect(u).toHaveLength(0) // 降级语义不变：读失败不阻断进门（返回 []）
    expect(warnSpy).toHaveBeenCalledTimes(1) // 修复点：不再静默（原空体 catch 零留痕）
    const [tag, msg] = warnSpy.mock.calls[0]!
    expect(tag).toBe('journal')
    expect(msg).toContain(jp) // 文案带路径
    expect(msg).toContain('EACCES') // 文案带错误信息
  })

  it('读成功路径不发 warn（守卫不误伤正常扫描）', () => {
    dir = mkdtempSync(join(tmpdir(), 'journal-r61c1-ok-'))
    const jp = join(dir, 'doc_1.jsonl')
    writeFileSync(
      jp,
      JSON.stringify({ opId: 'ok1', docId: 'doc_1', ts: 't', status: 'pending', content: '正文' }) + '\n',
      'utf-8',
    )
    const warnSpy = vi.spyOn(log, 'warn')
    const u = findUnsettled(jp)
    expect(u).toHaveLength(1)
    expect(u[0]!.opId).toBe('ok1')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
