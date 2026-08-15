import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeSnapshot,
  readSnapshot,
  pruneSnapshots,
  listSnapshotEntries,
  DEFAULT_SNAPSHOT_POLICY,
} from '../../src/document/snapshot.js'
import { listVersions } from '../../src/document/version.js'
import { decodeUlidTime } from '../../src/document/stable-id.js'

const HOUR = 3600_000
const DAY = 86_400_000

/** 造指定时间戳的 ULID（前 10 字符是 48bit ms；后缀区分同毫秒多个）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulidAt(ms: number, seq = 0): string {
  let v = BigInt(Math.floor(ms))
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.push(CROCKFORD[Number(v & 0x1fn)]!)
    v >>= 5n
  }
  return chars.reverse().join('') + String(seq).padStart(16, '0')
}

/** 直接落一个指定时间的快照文件（绕过 writeSnapshot 的节流/去重）。 */
function seedSnapshot(dir: string, docId: string, ms: number, content = 'x', seq = 0): string {
  const id = ulidAt(ms, seq)
  mkdirSync(join(dir, docId), { recursive: true })
  writeFileSync(
    join(dir, docId, `${id}.md`),
    `---\n快照ID: ${id}\n时间: ${new Date(ms).toISOString()}\n来源: autosave\n---\n${content}`,
    'utf-8',
  )
  return id
}

describe('snapshot', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writeSnapshot 建文件 + 返回 ULID id', () => {
    const id = writeSnapshot(dir, 'doc_1', '正文内容', { origin: 'manual' })
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const f = join(dir, 'doc_1', `${id}.md`)
    expect(existsSync(f)).toBe(true)
    const text = readFileSync(f, 'utf-8')
    expect(text).toContain('正文内容')
    expect(text).toContain('来源: manual')
  })

  it('writeSnapshot 带 reason/baseRevision 写入 front matter', () => {
    const id = writeSnapshot(dir, 'doc_1', 'x', {
      origin: 'autosave',
      reason: '冲突覆盖前',
      baseRevision: 'sha256:abc',
    })
    const text = readFileSync(join(dir, 'doc_1', `${id}.md`), 'utf-8')
    expect(text).toContain('原因: 冲突覆盖前')
    expect(text).toContain('基线: sha256:abc')
  })

  it('listSnapshots 降序（新在前）', async () => {
    writeSnapshot(dir, 'doc_1', 'a', { origin: 'x' })
    await new Promise((r) => setTimeout(r, 2))
    const id2 = writeSnapshot(dir, 'doc_1', 'b', { origin: 'x' })
    const list = listVersions(dir, 'doc_1')
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(id2)
  })

  it('无快照 → 空', () => {
    expect(listVersions(dir, 'doc_无')).toHaveLength(0)
  })
})

describe('snapshot · 去重与节流', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('同内容 → 跳过不落新文件', () => {
    const id1 = writeSnapshot(dir, 'doc_1', '一样的正文', { origin: 'manual' })
    const id2 = writeSnapshot(dir, 'doc_1', '一样的正文', { origin: 'manual' })
    expect(id1).not.toBeNull()
    expect(id2).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('X-P2-3：不同 origin 同内容 → 各自落盘（覆写留底不被 ai 轨迹去重吞掉）', () => {
    const id1 = writeSnapshot(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    const id2 = writeSnapshot(dir, 'doc_1', '同一段正文', { origin: 'draft-overwrite' })
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('X-P2-3：同 origin 同内容 → 仍去重', () => {
    writeSnapshot(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    const id2 = writeSnapshot(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    expect(id2).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('内容变了 → 正常落新文件', () => {
    writeSnapshot(dir, 'doc_1', '第一版', { origin: 'manual' })
    const id2 = writeSnapshot(dir, 'doc_1', '第二版', { origin: 'manual' })
    expect(id2).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('force=false 且窗口内已有快照 → 节流跳过', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 60_000, '旧内容') // 1 分钟前
    const id = writeSnapshot(dir, 'doc_1', '新内容', { origin: 'autosave' }, { force: false })
    expect(id).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('force=false 但已过节流窗口 → 正常写入', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 10 * 60_000, '旧内容') // 10 分钟前 > 5 分钟窗口
    const id = writeSnapshot(dir, 'doc_1', '新内容', { origin: 'autosave' }, { force: false })
    expect(id).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('force=true（缺省）不受节流限制', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 60_000, '旧内容')
    const id = writeSnapshot(dir, 'doc_1', '新内容', { origin: 'restore' })
    expect(id).not.toBeNull()
  })
})

describe('snapshot · readSnapshot', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('读回内容与元信息', () => {
    const id = writeSnapshot(dir, 'doc_1', '第五章正文', {
      origin: 'autosave',
      reason: '定稿章修改前留底（§6）',
      baseRevision: 'sha256:deadbeef',
    })!
    const r = readSnapshot(dir, 'doc_1', id)
    expect(r).not.toBeNull()
    expect(r!.content).toBe('第五章正文')
    expect(r!.meta.origin).toBe('autosave')
    expect(r!.meta.reason).toBe('定稿章修改前留底（§6）')
    expect(r!.meta.baseRevision).toBe('sha256:deadbeef')
    expect(r!.meta.time).toBe(decodeUlidTime(id))
  })

  it('正文自带 front matter → 逐字保真（不被当成快照 fm 吃掉）', () => {
    const 原文 = '---\n章号: 5\n标题: 破局\n---\n正文第一行\n正文第二行\n'
    const id = writeSnapshot(dir, 'doc_1', 原文, { origin: 'manual' })!
    expect(readSnapshot(dir, 'doc_1', id)!.content).toBe(原文)
  })

  it('非法 id 拒绝（防路径穿越）', () => {
    expect(readSnapshot(dir, 'doc_1', '../../etc/passwd')).toBeNull()
    expect(readSnapshot(dir, 'doc_1', 'not-a-ulid')).toBeNull()
  })

  it('不存在的 id → null', () => {
    expect(readSnapshot(dir, 'doc_1', ulidAt(Date.now()))).toBeNull()
  })

  it('listSnapshotEntries 带时间/来源/字数', () => {
    writeSnapshot(dir, 'doc_1', '一二三四五', { origin: 'manual' })
    const entries = listSnapshotEntries(dir, 'doc_1', (t) => t.length)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.origin).toBe('manual')
    expect(entries[0]!.words).toBe(5)
    expect(entries[0]!.time).toBeGreaterThan(0)
  })
})

describe('snapshot · 分层保留清理', () => {
  let dir: string
  const now = Date.UTC(2026, 6, 29, 12, 0, 0) // 固定"现在"，避免跨时段抖动
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('最近 2 小时内全留', () => {
    seedSnapshot(dir, 'd', now - 5 * 60_000, 'a', 1)
    seedSnapshot(dir, 'd', now - 30 * 60_000, 'b', 2)
    seedSnapshot(dir, 'd', now - 110 * 60_000, 'c', 3)
    const removed = pruneSnapshots(dir, 'd', DEFAULT_SNAPSHOT_POLICY, now)
    expect(removed).toBe(0)
    expect(listVersions(dir, 'd')).toHaveLength(3)
  })

  it('2-24 小时：每小时只留最早的一个', () => {
    // 同一小时内三个（5 小时前那个整点附近）
    const base = now - 5 * HOUR
    const earliest = seedSnapshot(dir, 'd', base, 'a', 1)
    seedSnapshot(dir, 'd', base + 10 * 60_000, 'b', 2)
    seedSnapshot(dir, 'd', base + 20 * 60_000, 'c', 3)
    pruneSnapshots(dir, 'd', DEFAULT_SNAPSHOT_POLICY, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(earliest)
  })

  it('1 天以上：每天只留最早的一个', () => {
    const base = now - 3 * DAY
    const earliest = seedSnapshot(dir, 'd', base, 'a', 1)
    seedSnapshot(dir, 'd', base + 3 * HOUR, 'b', 2)
    seedSnapshot(dir, 'd', base + 9 * HOUR, 'c', 3)
    pruneSnapshots(dir, 'd', DEFAULT_SNAPSHOT_POLICY, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(earliest)
  })

  it('超过 maxDays → 删', () => {
    seedSnapshot(dir, 'd', now - 20 * DAY, 'old', 1)
    seedSnapshot(dir, 'd', now - 60_000, 'new', 2)
    pruneSnapshots(dir, 'd', { maxDays: 14, maxCount: 30, throttleMinutes: 5 }, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(readSnapshot(dir, 'd', left[0]!.id)!.content).toBe('new')
  })

  it('maxCount 兜底：超出上限时留最新的', () => {
    // 最近 2 小时内 5 个（都在细粒度窗口，靠 maxCount 裁）
    for (let i = 0; i < 5; i++) seedSnapshot(dir, 'd', now - i * 60_000, `c${i}`, i)
    pruneSnapshots(dir, 'd', { maxDays: 14, maxCount: 3, throttleMinutes: 5 }, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(3)
    // 留下的是最新三个（now-0 / now-1min / now-2min）
    const times = left.map((s) => decodeUlidTime(s.id)).sort((a, b) => b - a)
    expect(times[0]).toBe(now)
    expect(times[2]).toBe(now - 2 * 60_000)
  })

  it('空目录 → 0，不抛', () => {
    expect(pruneSnapshots(dir, 'doc_无', DEFAULT_SNAPSHOT_POLICY, now)).toBe(0)
  })
})

describe('decodeUlidTime', () => {
  it('往返一致', () => {
    const ms = Date.UTC(2026, 6, 29, 8, 30, 0)
    expect(decodeUlidTime(ulidAt(ms))).toBe(ms)
  })

  it('非法字符 → 0', () => {
    expect(decodeUlidTime('!!!!!!!!!!')).toBe(0)
  })
})
