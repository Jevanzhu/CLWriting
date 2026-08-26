/**
 * Y-22 / Y-24（第五十七轮）回归——证据短引号兜底 + 崩溃 tmp 清扫。
 *
 * Y-22：extractEvidenceCore 短引号证据（「雪落」3 字，不满 {4,}）走 slice 兜底时
 * 先剥首尾引号——带引号字符 grep 正文整组 miss 会误报 lead-evidence-miss。
 * Y-24：sweepAbandonedTmpFiles 按 tmp 命名模式 + 5 分钟年龄门槛清扫崩溃残留；
 * 在途（年轻）tmp 不动。
 * R63-8（十一轮）：evidenceNeedles 多候选针串——混合短引证据（「雪落」无声）的
 * 内部闭引号留在单针串，正文以无引号形式写同短语时整组 miss；多候选任一命中即算。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { extractEvidenceCore, evidenceNeedles } from '../../src/check/leads.js'
import { leadEvidenceMatchesBody } from '../../src/check/lead-updates.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-y24-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Y-22: extractEvidenceCore 短引号', () => {
  it('「雪落」→ 雪落（剥引号后截取）', () => {
    expect(extractEvidenceCore('「雪落」')).toBe('雪落')
  })

  it('长引号证据仍走引号内优先（既有行为）', () => {
    expect(extractEvidenceCore('「大雪落满了山冈」')).toBe('大雪落满了山冈')
  })

  it('无引号证据照旧 slice（既有行为）', () => {
    expect(extractEvidenceCore('山门外玉佩轻响，少年抬头')).toBe('山门外玉佩轻响，')
  })
})

describe('R63-8: evidenceNeedles 多候选针串（任一命中即算）', () => {
  it('混合短引证据（「雪落」无声）→ 候选含引号内短串与全剥引号串，不含带闭引号的断链针串', () => {
    const needles = evidenceNeedles('「雪落」无声')
    expect(needles).toContain('雪落') // 引号内短串（Y-22 语义补全，不限 {4,}）
    expect(needles).toContain('雪落无声') // 全剥引号串（正文无引号写法的正身）
    expect(needles).toContain('雪落」无声') // 剥边引号原串（正文连引号写法）
    // 任一命中即算：正文写无引号短语不再整组 miss（修复前单针串 雪落」无人声 恒 miss）
    expect(leadEvidenceMatchesBody('夜里雪落无声，四野俱寂。', '「雪落」无声')).toBe(true)
    // 连引号一起写的正文也命中
    expect(leadEvidenceMatchesBody('他低声道：「雪落」无声胜有声。', '「雪落」无声')).toBe(true)
  })

  it('长引号证据：引号内长串为主候选，命中语义与修复前一致', () => {
    const needles = evidenceNeedles('「他终于看见焦痕背后的掌印。」')
    expect(needles).toContain('他终于看见焦痕背后的掌印。')
    expect(leadEvidenceMatchesBody('尘埃落定，他终于看见焦痕背后的掌印。', '「他终于看见焦痕背后的掌印。」')).toBe(true)
    expect(leadEvidenceMatchesBody('正文完全没有这句。', '「他终于看见焦痕背后的掌印。」')).toBe(false)
  })

  it('空证据/纯引号 → 零候选不误判兑现（includes("") 防线保留）', () => {
    expect(evidenceNeedles('')).toEqual([])
    expect(evidenceNeedles('「」')).toEqual([])
    expect(leadEvidenceMatchesBody('任意正文。', '')).toBe(false)
  })

  it('真正不在正文的证据仍 miss（多候选不是免检通道）', () => {
    expect(leadEvidenceMatchesBody('正文写的是另一件事。', '「雪落」无声')).toBe(false)
  })
})

describe('Y-24: sweepAbandonedTmpFiles', () => {
  it('超龄 tmp 被清、年轻 tmp 与非 tmp 文件不动', () => {
    mkdirSync(join(root, '写作'), { recursive: true })
    const old = join(root, '.ai-calls.json.12345.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp')
    const young = join(root, '写作', '.manifest.jsonl.12345.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp')
    const normal = join(root, '正文.md')
    writeFileSync(old, 'x')
    writeFileSync(young, 'x')
    writeFileSync(normal, 'x')
    const now = Date.now()
    utimesSync(old, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000))
    const removed = sweepAbandonedTmpFiles(root, { now })
    expect(removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(normal)).toBe(true)
  })
})
