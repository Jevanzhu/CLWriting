/**
 * R66-18（十四轮）：章摘要正文与指纹单次读盘同源回归。
 *
 * 此前 readDraft（读 body）与 computeRevision（读指纹）两次独立读盘——两读之间
 * 正文被改（H1→H2）会把 H2 指纹绑给 H1 正文的摘要（过期判定从此恒 fresh）。
 * 修复后单次读 Buffer 同源派生 body 与哈希；fm.sourceHash 必须等于该次字节快照。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 计数 mock：只统计正文文件的读取次数
const READS = vi.hoisted(() => ({ path: '', count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (typeof p === 'string' && p === READS.path) READS.count++
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { generateChapterSummary, chapterSummaryPath, effectiveConfig } from '../../src/process/summary.js'
import { computeRevision } from '../../src/document/revision.js'

let root: string
let bodyAbs: string

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  root = mkdtempSync(join(tmpdir(), 'clw-r66-18-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  bodyAbs = join(root, '写作', '正文', '001-第1章.md')
  writeFileSync(
    bodyAbs,
    '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第1章正文：山门外的玉佩在雨夜里连响了三下。\n',
    'utf-8',
  )
  READS.path = bodyAbs
  READS.count = 0
})

afterEach(() => {
  delete process.env['CLWRITING_DRIVER']
  rmSync(root, { recursive: true, force: true })
  READS.path = ''
})

describe('R66-18: 章摘要正文与指纹单次读盘同源', () => {
  it('生成期间正文只读一次；fm.sourceHash 绑该次字节快照的 sha256', async () => {
    const r = await generateChapterSummary({
      bookRoot: root,
      userDataPath: null,
      config: effectiveConfig(root, null),
      chapter: 1,
      bodyAbsPath: bodyAbs,
    })
    expect(r.ok).toBe(true)
    // 原实现 readDraft + computeRevision 两次独立读盘；修复后单次读 Buffer 派生两者
    expect(READS.count).toBe(1)

    // 摘要 fm 的 sourceHash 必须与正文当前字节的哈希一致（同源派生，无第二次读的时点漂移）
    const raw = readFileSync(chapterSummaryPath(root, 1), 'utf-8')
    const m = /^sourceHash:\s*(\S+)/m.exec(raw)
    expect(m?.[1]).toBe(computeRevision(bodyAbs))
  })

  it('正文读失败（文件消失）→ {ok:false} 不落盘（错误面与原 readDraft 失败一致）', async () => {
    rmSync(bodyAbs, { force: true })
    const r = await generateChapterSummary({
      bookRoot: root,
      userDataPath: null,
      config: effectiveConfig(root, null),
      chapter: 1,
      bodyAbsPath: bodyAbs,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('读正文失败')
    expect(existsSync(chapterSummaryPath(root, 1))).toBe(false)
  })
})
