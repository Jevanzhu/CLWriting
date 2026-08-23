/**
 * Y-22 / Y-24（第五十七轮）回归——证据短引号兜底 + 崩溃 tmp 清扫。
 *
 * Y-22：extractEvidenceCore 短引号证据（「雪落」3 字，不满 {4,}）走 slice 兜底时
 * 先剥首尾引号——带引号字符 grep 正文整组 miss 会误报 lead-evidence-miss。
 * Y-24：sweepAbandonedTmpFiles 按 tmp 命名模式 + 5 分钟年龄门槛清扫崩溃残留；
 * 在途（年轻）tmp 不动。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { extractEvidenceCore } from '../../src/check/leads.js'

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
