/**
 * R34D-14（三十四轮）：pruneVersions 对「头部不可读」版本的 fail-safe 保护。
 *
 * 场景核心：定稿档（pinned=true）的 front matter 头部被截断/损坏后，
 * readVersionMeta 返回 null → 此前按「非 pinned」走超期/maxCount 清理删除——
 * 头部受损的定稿里程碑被静默删掉，与写侧 R73-35「meta 不可读 fail-open 落写」
 * 的宁多勿失口径相反。修复后：是否定稿无法判定 ⇒ 不删（按 pinned 同等保护）。
 * 同时回归锁定：头部可读的非 pinned 旧版本仍正常被清理（不过度保护）。
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeVersion, pruneVersions, listVersions, DEFAULT_VERSION_POLICY } from '../../src/document/version.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let dir: string
const docId = 'doc_r34d_prune'

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-r34d-prune-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* mkdtempTracked 的 afterEach 兜底回收 */
  }
})

/** 指定毫秒时间戳的合成 ULID（尾部恒 0，仅测试用时间序构造，字母表同 fs/id.ts） */
function ulidAt(ms: number): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let v = BigInt(ms)
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.push(CROCKFORD[Number(v & 0x1fn)]!)
    v >>= 5n
  }
  return chars.reverse().join('') + '0'.repeat(16)
}

function exists(id: string | null): boolean {
  if (!id) return false
  return listVersions(dir, docId).some((s) => s.id === id)
}

/** 把版本文件头部截断成「未闭合 front matter」（readVersionMeta 判 null 的损坏形态） */
function corruptHead(id: string): void {
  writeFileSync(join(dir, docId, `${id}.md`), '---\n版本ID: 损坏\n时间: 头部截断\n')
}

/** 手工在盘上造一个版本文件（绕过 writeVersion，用于控制 ULID 时间序/头部形态） */
function craftVersionFile(id: string, origin: string, body: string, extraFm = ''): void {
  mkdirSync(join(dir, docId), { recursive: true })
  const text = `---\n版本ID: ${id}\n时间: 2026-08-31T00:00:00.000Z\n来源: ${origin}\n${extraFm}---\n${body}`
  writeFileSync(join(dir, docId, `${id}.md`), text)
}

describe('R34D-14：头部不可读版本的 prune 保护', () => {
  it('头部被截断的定稿档（pinned 不可判定）不被超期清理删除', () => {
    const pinnedId = writeVersion(dir, docId, '定稿内容', { origin: 'finalize', pinned: true })
    expect(pinnedId).not.toBeNull()
    corruptHead(pinnedId!)

    // 100 天后 prune：修复前按非 pinned 超期删除；修复后无法判定 ⇒ 保留
    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(0)
    expect(exists(pinnedId)).toBe(true)
  })

  it('头部不可读的旧版本在 maxCount 兜底时同样不被裁', () => {
    // 3 个新鲜的正常 autosave 版本（先落盘建目录）
    writeVersion(dir, docId, '草稿一', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿二', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿三', { origin: 'autosave' })
    // 手工造 40 天前的「头部截断定稿档」（ULID 时间序可控，writeVersion 只能写当下时刻）
    const oldId = ulidAt(Date.now() - 40 * 24 * 60 * 60 * 1000)
    corruptHead(oldId)
    expect(exists(oldId)).toBe(true)

    // maxCount=2：修复前头部不可读旧档按非 pinned 超期删除；修复后受保护
    const policy = { maxDays: 14, maxCount: 2, throttleMinutes: 0 }
    pruneVersions(dir, docId, policy)

    expect(exists(oldId)).toBe(true)
  })

  it('回归：头部可读的非 pinned 旧版本仍正常被清理（不过度保护）', () => {
    const oldId = ulidAt(Date.now() - 40 * 24 * 60 * 60 * 1000)
    craftVersionFile(oldId, 'autosave', '可读的旧草稿')
    expect(exists(oldId)).toBe(true)

    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY)
    expect(removed).toBe(1)
    expect(exists(oldId)).toBe(false)
  })
})
