/**
 * R66-6（十四轮）：伏笔足迹全书扫描的章正文指纹缓存回归。
 *
 * 此前 scanForeshadowTrails/searchForeshadowTrails 每次调用 walkMdEach + 逐章
 * readFile 整读全书正文（请求线程同步执行，200 万字长篇秒级阻塞事件循环）；
 * 修复后按 mtimeNs+size 指纹缓存章正文——二次扫描未变章节零重读，
 * 变更章指纹失配自动重读并更新足迹。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 计数 mock：透明转发 + 按绝对路径计数（只数章正文文件的读取）
const READS = vi.hoisted(() => new Map<string, number>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (typeof p === 'string') READS.set(p, (READS.get(p) ?? 0) + 1)
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { readForeshadows, scanForeshadowTrails } from '../../src/document/foreshadow.js'

let root: string
let p1: string
let p2: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r66-6-'))
  const vol = join(root, '写作', '正文', '第一卷')
  mkdirSync(vol, { recursive: true })
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  writeFileSync(join(root, '设定', '伏笔', '玉佩.md'), '---\n标题: 玉佩\n状态: 未回收\n重要性: 高\n关联词: 玉佩\n---\n', 'utf-8')
  p1 = join(vol, '0001-埋.md')
  p2 = join(vol, '0002-承.md')
  writeFileSync(p1, '---\n章号: 1\n标题: 埋\n---\n他摸了摸胸前的玉佩。\n', 'utf-8')
  writeFileSync(p2, '---\n章号: 2\n标题: 承\n---\n与关键词无关的正文。\n', 'utf-8')
  READS.clear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('R66-6: 伏笔章正文指纹缓存', () => {
  it('首扫读全部章 → 二扫未变章节零重读且足迹一致 → 变更章单章重读且结果更新', () => {
    const t1 = scanForeshadowTrails(root, readForeshadows(root))
    expect(t1.get('玉佩')!.hits.length).toBe(1)
    expect(READS.get(p1)).toBe(1)
    expect(READS.get(p2)).toBe(1)

    READS.clear()
    const t2 = scanForeshadowTrails(root, readForeshadows(root))
    expect(t2).toEqual(t1) // 缓存命中路径的结果与首扫逐字节一致
    expect(READS.get(p1) ?? 0).toBe(0) // 未变章节零重读
    expect(READS.get(p2) ?? 0).toBe(0)

    // 变更第 1 章（追加一次命中，size 变 → 指纹失配）：只重读该章
    writeFileSync(p1, '---\n章号: 1\n标题: 埋\n---\n他摸了摸胸前的玉佩，玉佩又响了一声。\n', 'utf-8')
    READS.clear()
    const t3 = scanForeshadowTrails(root, readForeshadows(root))
    expect(READS.get(p1)).toBe(1)
    expect(READS.get(p2) ?? 0).toBe(0)
    expect(t3.get('玉佩')!.hits.length).toBe(2) // 足迹按新正文更新
  })
})
