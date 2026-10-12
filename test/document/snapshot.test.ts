import { describe, it, test, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  writeVersion,
  readVersion,
  pruneVersions,
  listVersionEntries,
  DEFAULT_VERSION_POLICY,
  listVersions,
  readVersionMeta,
  readVersionRaw,
  encodeDocDirName,
  VERSIONS_DIR_NAME,
} from '../../src/document/version.js'
import { decodeUlidTime, ulid, generateDocId } from '../../src/document/stable-id.js'
import { DocumentService } from '../../src/document/service.js'
import { computeRevision } from '../../src/document/revision.js'

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

/** 直接落一个指定时间的快照文件（绕过 writeVersion 的节流/去重）。 */
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
    dir = mkdtempTracked(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writeVersion 建文件 + 返回 ULID id', () => {
    const id = writeVersion(dir, 'doc_1', '正文内容', { origin: 'manual' })
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const f = join(dir, 'doc_1', `${id}.md`)
    expect(existsSync(f)).toBe(true)
    const text = readFileSync(f, 'utf-8')
    expect(text).toContain('正文内容')
    expect(text).toContain('来源: manual')
  })

  it('writeVersion 带 reason/baseRevision 写入 front matter', () => {
    const id = writeVersion(dir, 'doc_1', 'x', {
      origin: 'autosave',
      reason: '冲突覆盖前',
      baseRevision: 'sha256:abc',
    })
    const text = readFileSync(join(dir, 'doc_1', `${id}.md`), 'utf-8')
    expect(text).toContain('原因: 冲突覆盖前')
    expect(text).toContain('基线: sha256:abc')
  })

  it('listSnapshots 降序（新在前）', async () => {
    writeVersion(dir, 'doc_1', 'a', { origin: 'x' })
    await new Promise((r) => setTimeout(r, 2))
    const id2 = writeVersion(dir, 'doc_1', 'b', { origin: 'x' })
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
    dir = mkdtempTracked(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('同内容 → 跳过不落新文件', () => {
    const id1 = writeVersion(dir, 'doc_1', '一样的正文', { origin: 'manual' })
    const id2 = writeVersion(dir, 'doc_1', '一样的正文', { origin: 'manual' })
    expect(id1).not.toBeNull()
    expect(id2).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('X-P2-3：不同 origin 同内容 → 各自落盘（覆写留底不被 ai 轨迹去重吞掉）', () => {
    const id1 = writeVersion(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    const id2 = writeVersion(dir, 'doc_1', '同一段正文', { origin: 'draft-overwrite' })
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('X-P2-3：同 origin 同内容 → 仍去重', () => {
    writeVersion(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    const id2 = writeVersion(dir, 'doc_1', '同一段正文', { origin: 'ai' })
    expect(id2).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('内容变了 → 正常落新文件', () => {
    writeVersion(dir, 'doc_1', '第一版', { origin: 'manual' })
    const id2 = writeVersion(dir, 'doc_1', '第二版', { origin: 'manual' })
    expect(id2).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('force=false 且窗口内已有快照 → 节流跳过', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 60_000, '旧内容') // 1 分钟前
    const id = writeVersion(dir, 'doc_1', '新内容', { origin: 'autosave' }, { force: false })
    expect(id).toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(1)
  })

  it('RB-KN-P2-6: 窗口内只有他 origin 版本（如 finalize）→ autosave 留底不被误节流', () => {
    // 直接落一个 finalize 来源的版本（绕过 writeVersion）：1 分钟前
    const ms = Date.now() - 60_000
    const id = ulidAt(ms, 0)
    mkdirSync(join(dir, 'doc_1'), { recursive: true })
    writeFileSync(
      join(dir, 'doc_1', `${id}.md`),
      `---\n快照ID: ${id}\n时间: ${new Date(ms).toISOString()}\n来源: finalize\n---\n旧内容`,
      'utf-8',
    )
    // 修复前：节流按「最新任意 origin」判窗口 → 此处 autosave 修改前留底被静默吞掉
    const sid = writeVersion(dir, 'doc_1', '新内容', { origin: 'autosave' }, { force: false })
    expect(sid).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('force=false 但已过节流窗口 → 正常写入', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 10 * 60_000, '旧内容') // 10 分钟前 > 5 分钟窗口
    const id = writeVersion(dir, 'doc_1', '新内容', { origin: 'autosave' }, { force: false })
    expect(id).not.toBeNull()
    expect(listVersions(dir, 'doc_1')).toHaveLength(2)
  })

  it('force=true（缺省）不受节流限制', () => {
    seedSnapshot(dir, 'doc_1', Date.now() - 60_000, '旧内容')
    const id = writeVersion(dir, 'doc_1', '新内容', { origin: 'restore' })
    expect(id).not.toBeNull()
  })
})

describe('snapshot · readVersion', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('读回内容与元信息', () => {
    const id = writeVersion(dir, 'doc_1', '第五章正文', {
      origin: 'autosave',
      reason: '定稿章修改前留底（§6）',
      baseRevision: 'sha256:deadbeef',
    })!
    const r = readVersion(dir, 'doc_1', id)
    expect(r).not.toBeNull()
    expect(r!.content).toBe('第五章正文')
    expect(r!.meta.origin).toBe('autosave')
    expect(r!.meta.reason).toBe('定稿章修改前留底（§6）')
    expect(r!.meta.baseRevision).toBe('sha256:deadbeef')
    expect(r!.meta.time).toBe(decodeUlidTime(id))
  })

  it('正文自带 front matter → 逐字保真（不被当成快照 fm 吃掉）', () => {
    const 原文 = '---\n章号: 5\n标题: 破局\n---\n正文第一行\n正文第二行\n'
    const id = writeVersion(dir, 'doc_1', 原文, { origin: 'manual' })!
    expect(readVersion(dir, 'doc_1', id)!.content).toBe(原文)
  })

  it('非法 id 拒绝（防路径穿越）', () => {
    expect(readVersion(dir, 'doc_1', '../../etc/passwd')).toBeNull()
    expect(readVersion(dir, 'doc_1', 'not-a-ulid')).toBeNull()
  })

  it('不存在的 id → null', () => {
    expect(readVersion(dir, 'doc_1', ulidAt(Date.now()))).toBeNull()
  })

  it('listVersionEntries 带时间/来源/字数', () => {
    writeVersion(dir, 'doc_1', '一二三四五', { origin: 'manual' })
    const entries = listVersionEntries(dir, 'doc_1', (t) => t.length)
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
    dir = mkdtempTracked(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('最近 2 小时内全留', () => {
    seedSnapshot(dir, 'd', now - 5 * 60_000, 'a', 1)
    seedSnapshot(dir, 'd', now - 30 * 60_000, 'b', 2)
    seedSnapshot(dir, 'd', now - 110 * 60_000, 'c', 3)
    const removed = pruneVersions(dir, 'd', DEFAULT_VERSION_POLICY, now)
    expect(removed).toBe(0)
    expect(listVersions(dir, 'd')).toHaveLength(3)
  })

  it('2-24 小时：每小时只留最早的一个', () => {
    // 同一小时内三个（5 小时前那个整点附近）
    const base = now - 5 * HOUR
    const earliest = seedSnapshot(dir, 'd', base, 'a', 1)
    seedSnapshot(dir, 'd', base + 10 * 60_000, 'b', 2)
    seedSnapshot(dir, 'd', base + 20 * 60_000, 'c', 3)
    pruneVersions(dir, 'd', DEFAULT_VERSION_POLICY, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(earliest)
  })

  it('1 天以上：每天只留最早的一个', () => {
    const base = now - 3 * DAY
    const earliest = seedSnapshot(dir, 'd', base, 'a', 1)
    seedSnapshot(dir, 'd', base + 3 * HOUR, 'b', 2)
    seedSnapshot(dir, 'd', base + 9 * HOUR, 'c', 3)
    pruneVersions(dir, 'd', DEFAULT_VERSION_POLICY, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(earliest)
  })

  it('超过 maxDays → 删', () => {
    seedSnapshot(dir, 'd', now - 20 * DAY, 'old', 1)
    seedSnapshot(dir, 'd', now - 60_000, 'new', 2)
    pruneVersions(dir, 'd', { maxDays: 14, maxCount: 30, throttleMinutes: 5 }, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(1)
    expect(readVersion(dir, 'd', left[0]!.id)!.content).toBe('new')
  })

  it('maxCount 兜底：超出上限时留最新的', () => {
    // 最近 2 小时内 5 个（都在细粒度窗口，靠 maxCount 裁）
    for (let i = 0; i < 5; i++) seedSnapshot(dir, 'd', now - i * 60_000, `c${i}`, i)
    pruneVersions(dir, 'd', { maxDays: 14, maxCount: 3, throttleMinutes: 5 }, now)
    const left = listVersions(dir, 'd')
    expect(left).toHaveLength(3)
    // 留下的是最新三个（now-0 / now-1min / now-2min）
    const times = left.map((s) => decodeUlidTime(s.id)).sort((a, b) => b - a)
    expect(times[0]).toBe(now)
    expect(times[2]).toBe(now - 2 * 60_000)
  })

  it('空目录 → 0，不抛', () => {
    expect(pruneVersions(dir, 'doc_无', DEFAULT_VERSION_POLICY, now)).toBe(0)
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

// ── 列表序改字节序比较：ULID 是 26 字符 Crockford base32（全大写 ASCII，0-9 在前
// A-Z 在后），字节序即编码序，高位在前 ⇒ 字节序降序 = 时间降序，与 locale 无关。──
describe('listVersions 排序：字节序降序 = 时间降序（不依赖 locale）', () => {
  const sortDir = join(tmpdir(), 'r0912-sort-versions')
  const SORT_DOC = 'doc_sortcheck'

  function plantVersion(id: string): void {
    const dir = join(sortDir, SORT_DOC)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.md`),
      `---\n版本ID: ${id}\n时间: ${new Date(decodeUlidTime(id)).toISOString()}\n来源: manual\n---\n\n内容\n`,
      'utf-8',
    )
  }

  it('列表序 = 字节序降序 = 时间降序（不依赖 locale）', () => {
    try {
      // 跨毫秒多版本 + 同毫秒并生（随机段不同）混排
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        ids.push(ulid())
        ids.push(ulid()) // 一半概率与上一枚同 ms（时间相等，字节序仍须确定收敛）
      }
      for (const id of ids) plantVersion(id)
      const list = listVersions(sortDir, SORT_DOC)
      expect(list).toHaveLength(ids.length)
      for (let i = 0; i < list.length - 1; i++) {
        const cur = list[i]!.id
        const next = list[i + 1]!.id
        // 字节序降序（判据本体：不允许 localeCompare 的环境等价类扰动）
        expect(cur > next || cur < next).toBe(true) // 无相等对（id 唯一）
        expect(cur > next).toBe(true)
        // 时间不升（decodeUlidTime 单调；同 ms 相等允许）
        expect(decodeUlidTime(cur)).toBeGreaterThanOrEqual(decodeUlidTime(next))
      }
    } finally {
      rmSync(sortDir, { recursive: true, force: true })
    }
  })
})

// ── 版本目录读写分裂：读侧对字面 + 编码两目录取并集（单版本读取双目录回退），写入恒
// 落编码目录；prune 按 listVersions 的 s.path 删除，自动覆盖两目录。字面目录场景仅
// mac/Linux 可造（win 上 `:` 目录非法）。──
describe('版本目录读写分裂修复（字面目录 + 编码写入）', () => {
  let root = ''
  let versionsDir = ''
  const DOC_ID = 'legacy:0123456789abcdef'
  const OLD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV' // 合法 ULID，时间戳落在 maxDays（14 天）期外

  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'clw-verdir-'))
    versionsDir = join(root, '工作区', '.版本')
  })

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function seedVersionFile(dirDocId: string, id: string, content: string): void {
    mkdirSync(join(versionsDir, dirDocId), { recursive: true })
    writeFileSync(
      join(versionsDir, dirDocId, `${id}.md`),
      `---\n版本ID: ${id}\n时间: 2018-05-01T00:00:00.000Z\n来源: autosave\n---\n${content}`,
      'utf8',
    )
  }

  // 字面冒号目录仅在 POSIX 可建（win 上 mkdir 即失败），win 跳过、mac/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')(
    '存量字面目录（新鲜版本）→ 再写新版本对 list/read/readMeta 全可见（修复前 listVersions 只见字面侧）',
    () => {
      // 种子用当前 ULID：writeVersion 末尾自带 prune，2018 老种子会被超期清掉干扰断言
      const seededId = ulid()
      seedVersionFile(DOC_ID, seededId, '字面侧旧版本内容')
      const newId = writeVersion(versionsDir, DOC_ID, '新版本内容', { origin: 'autosave' })
      expect(newId).not.toBeNull()

      // 新旧两版本都在列表（种子在字面目录、新写在编码目录）——本用例的判据是「可见性」，
      // 故按集合断言：ulid() 的 80bit 随机后缀非单调，同毫秒内两次生成的 id 大小关系不定，
      // 断言次序会在同毫秒巧合下概率性翻红（次序另由 compareVersionIdDesc 的字节序降序保证）。
      const list = listVersions(versionsDir, DOC_ID)
      expect(new Set(list.map((v) => v.id))).toEqual(new Set([newId, seededId]))

      const rv = readVersion(versionsDir, DOC_ID, newId!)
      expect(rv?.content).toBe('新版本内容')
      const rm = readVersionMeta(versionsDir, DOC_ID, newId!)
      expect(rm?.meta.origin).toBe('autosave')
      // 字面侧种子同样可读（readVersion 双目录回退的另一方向）
      expect(readVersion(versionsDir, DOC_ID, seededId)?.content).toBe('字面侧旧版本内容')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'prune 走并集：字面目录超期版本被清、编码目录新鲜版本保留（修复前只扫字面侧）',
    () => {
      // 双侧手工置文件后直调 pruneVersions（绕开 writeVersion 末尾的自带 prune）
      seedVersionFile(DOC_ID, OLD_ID, '字面侧超期版本')
      const freshId = ulid()
      seedVersionFile(encodeDocDirName(DOC_ID), freshId, '编码侧新鲜版本')

      const removed = pruneVersions(versionsDir, DOC_ID, DEFAULT_VERSION_POLICY)
      // 字面侧 2018 版本超 14 天期被清；编码侧刚生成不可能被清
      expect(removed).toBe(1)
      expect(listVersions(versionsDir, DOC_ID).map((v) => v.id)).toEqual([freshId])
      expect(existsSync(join(versionsDir, encodeDocDirName(DOC_ID), `${freshId}.md`))).toBe(true)
      expect(existsSync(join(versionsDir, DOC_ID, `${OLD_ID}.md`))).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')('同 id 双目录双份 → 列表去重（字面优先）', () => {
    seedVersionFile(DOC_ID, OLD_ID, '双份内容')
    seedVersionFile(encodeDocDirName(DOC_ID), OLD_ID, '双份内容')
    const list = listVersions(versionsDir, DOC_ID)
    expect(list.filter((v) => v.id === OLD_ID)).toHaveLength(1)
    expect(list[0]!.path).toContain(DOC_ID) // 字面目录优先（docVersionDirs 顺序）
  })

  // 无字面目录 = win 实际运行形态，跨平台直跑（win 上等价于唯一路径）
  it('纯净库（无字面目录）→ 写入落编码目录、读取同目录，字面目录永不创建', () => {
    const newId = writeVersion(versionsDir, DOC_ID, '全新内容', { origin: 'autosave' })
    expect(newId).not.toBeNull()
    // 含冒号 docId：字面目录与编码目录路径不同，断言字面侧从未被创建
    expect(existsSync(join(versionsDir, DOC_ID))).toBe(false)
    expect(readdirSync(join(versionsDir, encodeDocDirName(DOC_ID)))).toEqual([`${newId}.md`])
    expect(readVersion(versionsDir, DOC_ID, newId!)?.content).toBe('全新内容')
    expect(listVersions(versionsDir, DOC_ID)).toHaveLength(1)
  })
})

// ── restore 字节档覆盖非 UTF-8 文件的「覆盖前留底」字节保真：byteRestore（Buffer 透传
// save）是非 UTF-8 档（GBK 等）唯一合法覆写通道——既有防线对其放行。修复前 maybeSnapshot
// 未传磁盘内容，回退 utf-8 文本读：GBK 盘上内容被解码成 U+FFFD 写入 .版本（假留底）。
// 修复后 byteRestore 路径传原始字节，版本快照与被覆盖文件逐字节一致。──

describe('字节档 restore 覆盖前留底（字节保真）', () => {
  let bookRoot = ''
  beforeEach(() => {
    bookRoot = mkdtempTracked(join(tmpdir(), 'clw-r35-4-'))
  })
  afterEach(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  })

  test('byteRestore 覆盖 GBK 档 → 覆盖前留底为字节保真快照（零 U+FFFD 损伤）', async () => {
    const svc = new DocumentService({ bookRoot })
    const docId = generateDocId()
    const rel = '写作/正文/0001-旧档.md'
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    // GBK 双字节序列（非合法 UTF-8，与既有字节族用例口径一致）
    const gbk = Buffer.concat([
      Buffer.from('---\n章号: 1\n标题: 旧档\n---\n\n第一章 ', 'utf-8'),
      Buffer.from([0xbe, 0xc9, 0xb5, 0xb5]), // GBK「旧档」
      Buffer.from('\n正文继续\n', 'utf-8'),
    ])
    writeFileSync(join(bookRoot, rel), gbk)

    const r = await svc.save(docId, rel, {
      content: Buffer.from('---\n章号: 1\n标题: 旧档\n---\n\n恢复后的原始字节\n', 'utf-8'),
      expectedRevision: computeRevision(join(bookRoot, rel)),
      operationId: 'op-r35-4',
      origin: 'restore',
    })
    expect(r.ok).toBe(true)

    // 修复前：maybeSnapshot 回退 utf-8 文本读，快照是 U+FFFD 失真文本且 ≠ 原字节
    const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    const versions = listVersions(versionsDir, docId)
    expect(versions.length).toBe(1)
    const raw = readVersionRaw(versionsDir, docId, versions[0]!.id)
    expect(raw).not.toBeNull()
    expect(raw!.content.equals(gbk)).toBe(true)
    expect(raw!.content.includes(Buffer.from('\uFFFD', 'utf8'))).toBe(false)
    expect(raw!.meta.origin).toBe('restore')
  })
})

// ── snapshotPolicy 的 global.json stat 缓存：每次 save 原先都 existsSync+readFileSync
// global.json；修后 statSync（mtimeMs+size）不变则复用上次解析结果。测法（行为级，
// 不 mock fs）：①缓存命中不重读——把 global.json 改写为等长内容并把 mtime 回拨到缓存
// 时的值：stat 键未变 → 命中缓存 → 仍按旧值修剪；②失效取新值——正常改写（mtime 变化）
// → 下一次 save 即按新值修剪。──

describe('snapshotPolicy 的 global.json stat 缓存', () => {
  interface Ctx {
    root: string
    userData: string
    svc: DocumentService
    rel: string
    globalJson: string
    versionsDir: string
  }

  function setup(): Ctx {
    const root = mkdtempTracked(join(tmpdir(), 'r30-policy-book-'))
    const userData = mkdtempTracked(join(tmpdir(), 'r30-policy-ud-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n第一版\n', 'utf-8')
    const globalJson = join(userData, 'global.json')
    writeFileSync(globalJson, '{"snapMaxCount":2,"snapMaxDays":90}')
    const svc = new DocumentService({ bookRoot: root, userDataPath: userData })
    return {
      root,
      userData,
      svc,
      rel: '写作/正文/0001-开篇.md',
      globalJson,
      versionsDir: join(root, '工作区', VERSIONS_DIR_NAME),
    }
  }

  /** 以 restore origin（强制留底，跳过节流）覆盖保存一次，内容各不相同。 */
  async function restoreSave(ctx: Ctx, content: string): Promise<void> {
    const abs = join(ctx.root, ...ctx.rel.split('/'))
    const r = await ctx.svc.save('doc_policy', ctx.rel, {
      content,
      expectedRevision: computeRevision(abs),
      operationId: `op-${content}`,
      origin: 'restore',
    })
    expect(r.ok).toBe(true)
  }

  test('stat 键未变 → 命中缓存不重读（等长改写 + mtime 回拨后仍按旧策略修剪）', async () => {
    const ctx = setup()
    try {
      // 堆到 maxCount=2 的封顶态：3 次强制留底 → prune 只留最新 2 版
      await restoreSave(ctx, '第二版\n')
      await restoreSave(ctx, '第三版\n')
      await restoreSave(ctx, '第四版\n')
      expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)

      // 等长改写 global.json（2→9）+ mtime 回拨：stat 键（floor(mtimeMs)+size）不变
      const st = statSync(ctx.globalJson)
      writeFileSync(ctx.globalJson, '{"snapMaxCount":9,"snapMaxDays":90}')
      utimesSync(ctx.globalJson, new Date(st.atimeMs), new Date(st.mtimeMs))
      const st2 = statSync(ctx.globalJson)
      expect(st2.size).toBe(st.size)
      expect(Math.floor(st2.mtimeMs)).toBe(Math.floor(st.mtimeMs))

      // 第 4 次留底：缓存命中 → 仍按 snapMaxCount=2 修剪（若重读得 9 则会留 3 版）
      await restoreSave(ctx, '第五版\n')
      expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
      rmSync(ctx.userData, { recursive: true, force: true })
    }
  })

  test('global.json 变更（mtime/size 变化）→ 缓存失效取新值，下次 save 即生效', async () => {
    const ctx = setup()
    try {
      await restoreSave(ctx, '第二版\n')
      await restoreSave(ctx, '第三版\n')
      expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(2)
      // 手工编辑 global.json：snapMaxCount 2→1（正常写入，mtime 变化）
      writeFileSync(ctx.globalJson, '{"snapMaxCount":1,"snapMaxDays":90}')
      await restoreSave(ctx, '第四版\n')
      expect(listVersions(ctx.versionsDir, 'doc_policy').length).toBe(1)
    } finally {
      rmSync(ctx.root, { recursive: true, force: true })
      rmSync(ctx.userData, { recursive: true, force: true })
    }
  })
})
