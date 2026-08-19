/**
 * batch-pause（M6 #34 连写暂停元状态）模块单测：
 * read/write/clear 的文件契约——round-trip、坏 JSON 容错、其他键保留/清除边界。
 * 读侧消费方见 state.ts buildRecap；写侧消费方见 self-heal orchestrateBatch（集成测试
 * 在 test/studio/self-heal-batch-pause.test.ts）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBatchPause, writeBatchPause, clearBatchPause } from '../../src/state/batch-pause.js'

let dir: string
const fp = (): string => join(dir, '工作区', '待定稿', '.auto-batch.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-batchpause-'))
  mkdirSync(join(dir, '工作区', '待定稿'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readBatchPause', () => {
  it('无文件 → undefined', () => {
    expect(readBatchPause(dir)).toBeUndefined()
  })

  it('坏 JSON → undefined（读侧永不抛）', () => {
    writeFileSync(fp(), 'not-json{')
    expect(readBatchPause(dir)).toBeUndefined()
  })

  it('paused 为 null / 缺 at_chapter / reason 非串 → undefined', () => {
    writeFileSync(fp(), JSON.stringify({ paused: null }))
    expect(readBatchPause(dir)).toBeUndefined()
    writeFileSync(fp(), JSON.stringify({ paused: { reason: 'escalate' } }))
    expect(readBatchPause(dir)).toBeUndefined()
    writeFileSync(fp(), JSON.stringify({ paused: { at_chapter: 2, reason: 7 } }))
    expect(readBatchPause(dir)).toBeUndefined()
  })
})

describe('writeBatchPause → readBatchPause round-trip', () => {
  it('atChapter/reason/detail 保真；detail 缺省读出空串', () => {
    writeBatchPause(dir, { atChapter: 3, reason: 'escalate', detail: '命中禁词「顿时」' })
    expect(readBatchPause(dir)).toEqual({ atChapter: 3, reason: 'escalate', detail: '命中禁词「顿时」' })
    // detail 省略时读侧补空串（readBatchPause 契约）
    writeFileSync(fp(), JSON.stringify({ paused: { at_chapter: 3, reason: 'aborted' } }))
    expect(readBatchPause(dir)).toEqual({ atChapter: 3, reason: 'aborted', detail: '' })
  })

  it('覆盖写 paused；文件里其他键保留（未来扩展不互踩）', () => {
    writeFileSync(fp(), JSON.stringify({ last_total: 8 }))
    writeBatchPause(dir, { atChapter: 2, reason: 'failed', detail: '上限' })
    const obj = JSON.parse(readFileSync(fp(), 'utf-8')) as Record<string, unknown>
    expect(obj['last_total']).toBe(8)
    expect(readBatchPause(dir)).toEqual({ atChapter: 2, reason: 'failed', detail: '上限' })
  })
})

describe('clearBatchPause', () => {
  it('只剩 paused → 删文件', () => {
    writeBatchPause(dir, { atChapter: 1, reason: 'aborted', detail: '' })
    clearBatchPause(dir)
    expect(existsSync(fp())).toBe(false)
    expect(readBatchPause(dir)).toBeUndefined()
  })

  it('还有其他键 → 保留改写（只摘 paused）', () => {
    writeFileSync(fp(), JSON.stringify({ last_total: 8, paused: { at_chapter: 1, reason: 'aborted' } }))
    clearBatchPause(dir)
    const obj = JSON.parse(readFileSync(fp(), 'utf-8')) as Record<string, unknown>
    expect(obj['last_total']).toBe(8)
    expect('paused' in obj).toBe(false)
  })

  it('无 paused 键 → no-op（文件原样）；无文件 → no-op 不抛', () => {
    writeFileSync(fp(), JSON.stringify({ last_total: 8 }))
    clearBatchPause(dir)
    expect(JSON.parse(readFileSync(fp(), 'utf-8'))).toEqual({ last_total: 8 })
    expect(() => clearBatchPause(dir)).not.toThrow()
  })
})
