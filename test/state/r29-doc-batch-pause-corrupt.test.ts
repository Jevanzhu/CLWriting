/**
 * C-7（二十九轮）回归：clearBatchPause 坏 JSON 不再直接删整文件。
 *
 * 背景：解析失败时原实现 rmSync 直接删——文件里除 paused 外的其他键（未来扩展的
 * 批处理进度等）无痕丢失。修复后先把原文件改名保留为 <名>.corrupt 留证（同名已存在
 * 则时间戳后缀不覆盖前证），再写全新 { paused: false }。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBatchPause, writeBatchPause, clearBatchPause } from '../../src/state/batch-pause.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let dir: string
const fp = (): string => join(dir, '工作区', '待定稿', '.auto-batch.json')

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-r29-pause-'))
  mkdirSync(join(dir, '工作区', '待定稿'), { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('C-7 / clearBatchPause 坏 JSON 留证', () => {
  it('坏 JSON → 原文保留为 .corrupt，重建 {paused:false}，不再丢全部键', async () => {
    const raw = '{"paused":{"at_chapter":2,"reason":"failed"},"progress_stage":7'
    writeFileSync(fp(), raw, 'utf-8') // 截断 JSON（半写形态）
    await clearBatchPause(dir)
    // 原文留证
    expect(existsSync(`${fp()}.corrupt`)).toBe(true)
    expect(readFileSync(`${fp()}.corrupt`, 'utf-8')).toBe(raw)
    // 全新文件：paused=false（读侧判无暂停），不含原坏内容
    expect(readBatchPause(dir)).toBeUndefined()
    const obj = JSON.parse(readFileSync(fp(), 'utf-8')) as { paused?: unknown }
    expect(obj['paused']).toBe(false)
    expect(readFileSync(fp(), 'utf-8')).not.toContain('progress_stage')
  })

  it('.corrupt 已存在 → 时间戳后缀另存，不覆盖前证', async () => {
    writeFileSync(`${fp()}.corrupt`, '上一代坏文件', 'utf-8')
    writeFileSync(fp(), '这一代{坏', 'utf-8')
    await clearBatchPause(dir)
    // 前证原样
    expect(readFileSync(`${fp()}.corrupt`, 'utf-8')).toBe('上一代坏文件')
    // 新证落在带时间戳的变体名下
    const siblings = readdirSync(join(dir, '工作区', '待定稿')).filter((n) => n.startsWith('.auto-batch.json.corrupt-'))
    expect(siblings).toHaveLength(1)
    expect(readFileSync(join(dir, '工作区', '待定稿', siblings[0]!), 'utf-8')).toBe('这一代{坏')
  })

  it('留证重建后写/清链路照常（round-trip 不回归）', async () => {
    writeFileSync(fp(), 'not-json{', 'utf-8')
    await clearBatchPause(dir)
    await writeBatchPause(dir, { atChapter: 3, reason: 'escalate', detail: '命中禁词' })
    expect(readBatchPause(dir)).toEqual({ atChapter: 3, reason: 'escalate', detail: '命中禁词' })
    await clearBatchPause(dir)
    expect(existsSync(fp())).toBe(false)
  })
})
