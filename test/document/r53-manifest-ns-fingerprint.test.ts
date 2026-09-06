/**
 * R53-D-1（五十三轮）回归：manifest 指纹缓存 mtimeMs → mtimeNs（bigint stat）。
 *
 * 原 `${size}:${mtimeMs}` 指纹在 FAT/exFAT（mtime 2 秒粒度）+ 同尺寸他进程写
 * （外部编辑器改清单）下不变 → 缓存陈旧命中 → 后续 RMW 以旧表整文件回写把外部
 * 修改回滚。修复：指纹改 `${size}:${mtimeNs}`（bigint stat，chapters.ts Z-21 /
 * tree.ts probeCache 同口径先例）。
 *
 * 手法：vi.mock('node:fs') 只对「清单路径 + bigint 面」拦截 statSync，前后两次读
 * 各喂一帧 fake stat（size/mtimeMs 全同、mtimeNs 推进）——确定性钉死契约，不依赖
 * 本机 FS 的 mtime 粒度（本机 APFS 的 ms 值本就亚毫秒漂移，真盘两读旧实现也侥幸绿）。
 * 外部改写走裸 writeFileSync（不经 writeManifest——外部编辑器不会替我们清缓存）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type StatFrame = { size: bigint; mtimeMs: bigint; mtimeNs: bigint }
const statQueue: StatFrame[] = []
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (p: string, opts?: { bigint?: boolean }) => {
      // 只拦「清单路径 + bigint 面 + 队列有货」的组合；其余（锁清扫等）透传 actual
      if (opts?.bigint && typeof p === 'string' && p.endsWith('文档清单.jsonl') && statQueue.length > 0) {
        return statQueue.shift() as never
      }
      return actual.statSync(p, opts as never)
    },
  }
})

import { readManifest, writeManifest, __manifestCacheTestHooks } from '../../src/document/manifest.js'
import type { Manifest } from '../../src/document/manifest.js'

let dir: string
const fp = (): string => join(dir, '项目', '文档清单.jsonl')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r53-d1-'))
  __manifestCacheTestHooks.clear()
})

afterEach(() => {
  statQueue.length = 0
  rmSync(dir, { recursive: true, force: true })
})

function manifestOf(path: string): Manifest {
  return {
    version: 1,
    entries: new Map([['doc-1', { id: 'doc-1', nodeType: 'document', path, parentId: null }]]),
  }
}

/** 与 writeManifest 相同行格式的裸 jsonl（外部编辑器直写面）；path 等长替换保字节等长 */
function jsonlOf(path: string): string {
  return `${JSON.stringify({ version: 1, type: 'header' })}\n${JSON.stringify({ id: 'doc-1', nodeType: 'document', path, parentId: null })}\n`
}

describe('R53-D-1: manifest 指纹 mtimeNs 化', () => {
  it('同尺寸 + 同 mtimeMs（FAT 粗粒度窗口）他进程写 → ns 指纹失配，缓存失效重读新内容', () => {
    writeManifest(fp(), manifestOf('写作/第1章.md'))
    // 第一读（消费帧 A）：填缓存
    statQueue.push({ size: 100n, mtimeMs: 1000n, mtimeNs: 1_000_000_000n })
    expect(readManifest(fp()).entries.get('doc-1')!.path).toBe('写作/第1章.md')

    // 外部编辑器同字节长度改写（第1章 → 第9章，等长替换），mtime 落在同一粗粒度
    // 窗口：mtimeMs 全同、仅 ns 推进（帧 B）
    writeFileSync(fp(), jsonlOf('写作/第9章.md'))
    statQueue.push({ size: 100n, mtimeMs: 1000n, mtimeNs: 1_500_000_000n })
    // 修复前：sig = "100:1000" 两读相同 → 陈旧命中返回旧表「第1章」（RMW 回写即吞外部修改）
    expect(readManifest(fp()).entries.get('doc-1')!.path).toBe('写作/第9章.md')
  })

  it('stat 未变（同 size 同 mtimeNs）→ 指纹稳定命中缓存（副本出仓语义不变）', () => {
    writeManifest(fp(), manifestOf('写作/第1章.md'))
    statQueue.push(
      { size: 100n, mtimeMs: 1000n, mtimeNs: 1_000_000_000n },
      { size: 100n, mtimeMs: 1000n, mtimeNs: 1_000_000_000n },
    )
    const a = readManifest(fp()) // 第一读：填缓存（消费帧 A）
    const b = readManifest(fp()) // 第二读：命中（消费帧 B，零差异）
    expect(b.entries.get('doc-1')!.path).toBe(a.entries.get('doc-1')!.path)
    expect(b.entries.get('doc-1')).not.toBe(a.entries.get('doc-1')) // 拷贝出仓保持
  })
})
