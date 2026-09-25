/**
 * R34D-15（三十四轮）：去重指纹缓存存活校验「最新同 origin」回归。
 *
 * 场景核心（双进程）：本进程缓存指向版本 id1（origin=manual，内容 C）后，他进程
 * 写入了更新的同 origin 版本 id2（内容 D）——id1 仍在盘，原校验（只验「id 在盘」）
 * 判缓存存活，再写内容 C 时 fp 与 id1 相等 → 错误去重跳写，快照链尾部失真
 * （盘上最新同 origin 是 D，C 的回归时刻未被留底）。修复后校验收紧为「id 仍是
 * 盘上最新同 origin 版本」：途中出现更新同 origin（或其 meta 不可读致新旧无法
 * 判定）→ 缓存失效，回读盘比对。另锁定跨 origin 新版不误伤缓存（优化不回退）。
 *
 * 双进程时序用「手工在盘上造版本文件」模拟（绕过 writeVersion 的写后缓存更新），
 * ULID 时间序可控（尾部恒 0 的合成 ULID）。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeVersion, listVersions, readVersion } from '../../src/document/version.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let dir: string
const docId = 'doc_r34d_cache'

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-r34d-cache-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* mkdtempTracked 的 afterEach 兜底回收 */
  }
})

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 指定毫秒时间戳的合成 ULID（尾部恒 0，仅测试用时间序构造，字母表同 fs/id.ts） */
function ulidAt(ms: number): string {
  let v = BigInt(ms)
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.push(CROCKFORD[Number(v & 0x1fn)]!)
    v >>= 5n
  }
  return chars.reverse().join('') + '0'.repeat(16)
}

/** 模拟他进程写入一个正常版本文件（fm 形态对齐 writeVersion，不动本进程缓存） */
function foreignWrite(id: string, origin: string, body: string): void {
  const text = `---\n版本ID: ${id}\n时间: 2026-08-31T00:00:00.000Z\n来源: ${origin}\n---\n${body}`
  writeFileSync(join(dir, docId, `${id}.md`), text)
}

describe('R34D-15：缓存指向非最新同 origin 时不得去重跳写', () => {
  it('他进程已写更新的同 origin 版本 → 重写旧内容必须落新版本（不得按旧缓存去重）', () => {
    // ① 本进程写 C（manual）→ 缓存指向 id1
    const id1 = writeVersion(dir, docId, '内容C', { origin: 'manual' })
    expect(id1).not.toBeNull()
    // ② 模拟他进程写入更新的同 origin 版本（内容 D）——本进程缓存仍指向 id1
    const id2 = ulidAt(Date.now() + 60_000)
    foreignWrite(id2, 'manual', '内容D')

    // ③ 重写内容 C：修复前缓存 id1「在盘」且 fp 相等 → 错误 return null（跳写）；
    //    修复后缓存非最新同 origin → 失效回读盘：最新同 origin（id2）是 D ≠ C → 落新版本
    const id3 = writeVersion(dir, docId, '内容C', { origin: 'manual' })
    expect(id3).not.toBeNull()
    expect(listVersions(dir, docId)).toHaveLength(3)

    // ④ 链尾正确性：再写 D 应与「真实的最新同 origin」id2 去重（回读盘比对路径）
    expect(writeVersion(dir, docId, '内容D', { origin: 'manual' })).toBeNull()
  })

  it('他进程只写了更新的跨 origin 版本 → 缓存仍是最新同 origin → 同内容照常去重（不误伤优化）', () => {
    const id1 = writeVersion(dir, docId, '内容C', { origin: 'manual' })
    expect(id1).not.toBeNull()
    // 更新的 finalize 版本（跨 origin，不参与 manual 域去重）
    foreignWrite(ulidAt(Date.now() + 60_000), 'finalize', '定稿内容')

    // 缓存校验途中只遇跨 origin → id1 仍最新同 origin → fp 相等去重跳写
    expect(writeVersion(dir, docId, '内容C', { origin: 'manual' })).toBeNull()
    expect(listVersions(dir, docId)).toHaveLength(2)
  })

  it('新于缓存的版本头部不可读 → 新旧无法判定 → 缓存按失效处理（fail-open 落写）', () => {
    const id1 = writeVersion(dir, docId, '内容C', { origin: 'manual' })
    expect(id1).not.toBeNull()
    // 模拟他进程写入头部截断的更新版本：同源与否无法判定
    const id2 = ulidAt(Date.now() + 60_000)
    writeFileSync(join(dir, docId, `${id2}.md`), '---\n版本ID: 损坏\n时间: 截断\n')

    // 修复前：缓存 id1 在盘且 fp 相等 → 静默跳写；修复后：无法判定 → 失效 →
    // 读盘比对在 id2 处 meta 不可读（R73-35 fail-open）→ 落写
    const id3 = writeVersion(dir, docId, '内容C', { origin: 'manual' })
    expect(id3).not.toBeNull()
    expect(readVersion(dir, docId, id3!)?.content).toBe('内容C')
  })
})
