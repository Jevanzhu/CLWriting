/**
 * R73-33 / R73-34 / R73-35 / R73-39 / R73-40（二十一轮 C 域）回归。
 *
 * R73-33：withManifestLock 锁超时 fail-closed（不再降级裸写）——持锁超时须抛错且清单
 *         文件字节不变（防双进程同时降级时整文件覆盖丢 finalizedRevision）。
 * R73-34：doTrash 目标 .trash 文件已存在（上次清单删除失败残留）→ 加时间戳后缀保双份，
 *         不静默覆盖上一版回收站内容。
 * R73-35：writeVersion 去重/节流循环对 readVersionMeta 不可读的版本 fail-open 落写，
 *         不再 continue 落到更旧版本比对（恰等旧版时跳写致快照链尾部失真）。
 * R73-39：migrateLegacyForeshadows 目标已存在走 createFileExclusive 语义（EEXIST 续跑
 *         补删旧源，不覆盖作者编辑）。
 * R73-40：updateDocMeta 对盘上字节单次读（UTF-8 判据与写回同源；正常/GBK 两态不回归）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { withManifestLock, readManifest, writeManifest, upsertEntry, __setManifestLockTimeoutForTest, type Manifest } from '../../src/document/manifest.js'
import { DocumentService } from '../../src/document/service.js'
import { writeVersion, encodeDocDirName } from '../../src/document/version.js'
import { listTrash, readTrashManifest } from '../../src/document/trash.js'
import { migrateLegacyForeshadows, readForeshadows } from '../../src/document/foreshadow.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

function holdLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}
// ── R73-33：清单锁超时 fail-closed ──────────────────────

describe('R73-33 / withManifestLock 超时拒绝不降级', () => {
  let root: string
  let manifestPath: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-mlock-'))
    manifestPath = join(root, '项目', '文档清单.jsonl')
    const m: Manifest = { version: 1, entries: new Map() }
    upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: '写作/正文/0001-a.md', parentId: null })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeManifest(manifestPath, m)
    __setManifestLockTimeoutForTest(60) // 缩短锁等待保测试快
  })
  afterEach(() => {
    __setManifestLockTimeoutForTest(5_000)
    rmSync(root, { recursive: true, force: true })
  })

  it('他进程存活持锁 → 抛错拒绝，清单文件字节不变', () => {
    const before = readFileSync(manifestPath, 'utf-8')
    holdLock(`${manifestPath}.lock`)
    expect(() =>
      withManifestLock(manifestPath, () => {
        const m = readManifest(manifestPath)
        m.entries.delete('doc_1')
        writeManifest(manifestPath, m)
      }),
    ).toThrow(/清单锁获取超时/)
    // 修复前：降级裸写 → doc_1 条目被吞；修复后：文件未被改
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
    expect(readManifest(manifestPath).entries.has('doc_1')).toBe(true)
  })

  it('无争用 → 正常执行并返回，锁释放干净', () => {
    const out = withManifestLock(manifestPath, () => 'ok-value')
    expect(out).toBe('ok-value')
    expect(existsSync(`${manifestPath}.lock`)).toBe(false)
  })
})

// ── R73-34：doTrash 确定性命名残留加时间戳后缀 ──────────────

describe('R73-34 / doTrash 残留同名 .trash 不覆盖', () => {
  let root: string
  let svc: DocumentService
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-trash-'))
    svc = new DocumentService({ bookRoot: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('上次软删残留的 .trash 文件在位 → 再次软删另存时间戳后缀，旧残留字节不变', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0001-旧稿.md', content: '---\n章号: 1\n标题: 旧稿\n---\n\n正文。\n' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const docId = created.docId
    // 模拟上次软删的残留：同 docId 的确定性 .trash 命名已被占用（清单删除失败残留态）
    const staleRel = `工作区/.trash/${encodeDocDirName(docId)}-0001-旧稿.md`
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(root, staleRel), '上一版回收站内容', 'utf-8')

    const r = await svc.trashDocument({ docId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 落位是带时间戳的新路径，旧残留不被覆盖
    expect(r.trashedPath).not.toBe(staleRel)
    expect(r.trashedPath).toMatch(/-旧稿-\d+\.md$/)
    expect(readFileSync(join(root, r.trashedPath), 'utf-8')).toContain('正文。')
    expect(readFileSync(join(root, staleRel), 'utf-8')).toBe('上一版回收站内容')
    // 回收站登记指向真实落位
    const entry = readTrashManifest(root).find((e) => e.id === docId)
    expect(entry?.trashedPath).toBe(r.trashedPath)
  })

  it('无残留 → 确定性命名照常（回归不漂移），回收站可见', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0002-新章.md', content: '---\n章号: 2\n标题: 新章\n---\n\n内容。\n' })
    if (!created.ok) throw new Error('prereq')
    const r = await svc.trashDocument({ docId: created.docId })
    expect(r.ok).toBe(true)
    expect(listTrash(root)).toHaveLength(1)
  })
})

// ── R73-35：writeVersion 去重/节流对 meta 不可读 fail-open ──────────────

describe('R73-35 / 版本去重对损坏头部 fail-open 落写', () => {
  let root: string
  let versionsDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-ver-'))
    versionsDir = join(root, '工作区', '.版本')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('最新版本头部损坏且旧版恰等新内容 → 仍落写（不跳写）', () => {
    // 造两版：v1 = 内容X（旧）、v2 = 内容Y（最新）
    writeVersion(versionsDir, 'doc_v1', '内容X', { origin: 'ai' })
    writeVersion(versionsDir, 'doc_v1', '内容Y', { origin: 'ai' })
    // 把最新版（v2）头部写坏（readVersionMeta → null，模拟损坏）
    const dir = join(versionsDir, encodeDocDirName('doc_v1'))
    const ids = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    writeFileSync(join(dir, ids.at(-1)!), '头部损坏无 front matter', 'utf-8')

    // 同旧版内容 X 再留底：修复前 → 损坏版 continue 落到旧版比对命中 → 跳写（返回
    // null，快照链尾部失真）；修复后 → meta 不可读无法判定 → fail-open 落写
    const r = writeVersion(versionsDir, 'doc_v1', '内容X', { origin: 'ai' })
    expect(r).not.toBeNull()
  })

  it('节流窗口：最新版本头部损坏 → 不节流，照常落写', () => {
    writeVersion(versionsDir, 'doc_v2', '第一版', { origin: 'autosave' })
    const dir = join(versionsDir, encodeDocDirName('doc_v2'))
    const ids = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    writeFileSync(join(dir, ids.at(-1)!), '损坏头部', 'utf-8')
    const r = writeVersion(
      versionsDir, 'doc_v2', '第二版不同内容', { origin: 'autosave' },
      { force: false, policy: { maxDays: 3650, maxCount: 1000, throttleMinutes: 30 } },
    )
    expect(r).not.toBeNull()
  })
})

// ── R73-39：伏笔迁移目标已存在 → 独占创建语义续跑补删 ──────────────

describe('R73-39 / 伏笔迁移 TOCTOU 收口', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-fsh-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('目标已在（作者已编辑）→ 不覆盖作者版，补删旧源计续跑', () => {
    const oldDir = join(root, '大纲', '伏笔')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, '伏笔-031-灭门真凶.md'),
      '---\n编号: 伏笔-031\n标题: 灭门真凶\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
    // 模拟并发/续跑态：目标已落位且被作者改过
    const newDir = join(root, '设定', '伏笔')
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, '伏笔-031-灭门真凶.md'), '---\n状态: 已回收\n关联词: 焦痕\n标题: 灭门真凶\n---\n\n作者改过的版本\n', 'utf-8')

    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(1)
    expect(r.details[0]).toContain('续跑补删旧源')
    // 旧源已补删；作者编辑版未被覆盖
    expect(existsSync(join(oldDir, '伏笔-031-灭门真凶.md'))).toBe(false)
    expect(readFileSync(join(newDir, '伏笔-031-灭门真凶.md'), 'utf-8')).toContain('作者改过的版本')
  })

  it('正常迁移：独占创建成功，字段正确', () => {
    const oldDir = join(root, '大纲', '伏笔')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, '伏笔-032-密室.md'),
      '---\n编号: 伏笔-032\n标题: 密室\n状态: 进行中\n开启章: 2\n---\n\n## 履历\n',
      'utf-8',
    )
    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(1)
    const list = readForeshadows(root)
    expect(list).toHaveLength(1)
    expect(list[0]!.标题).toBe('密室')
  })
})

// ── R73-40：updateDocMeta 对盘上字节单次读 ──────────────

describe('R73-40 / updateDocMeta 单次读（UTF-8 判据与写回同源）', () => {
  let root: string
  let svc: DocumentService
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-docmeta-'))
    svc = new DocumentService({ bookRoot: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('正常 UTF-8 文档 → meta 更新成功，既有 fm 其余键与正文逐字保留', async () => {
    const created = await svc.createDocument({
      relPath: '写作/正文/0003-卷宗.md',
      content: '---\n章号: 3\n标题: 卷宗\n备注: 旧备注\n---\n\n正文内容。\n',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const r = svc.updateDocMeta(created.docId, { 标题: '卷宗·改' })
    expect(r.ok).toBe(true)
    const out = readFileSync(join(root, '写作/正文/0003-卷宗.md'), 'utf-8')
    expect(out).toContain('标题: 卷宗·改')
    expect(out).toContain('备注: 旧备注') // 补丁式写回：目标键以外不动
    expect(out).toContain('正文内容。')
  })

  it('盘上是 GBK 字节 → WRITE_ERROR 拒绝且文件字节不变（判据与写回同源，不回归）', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0004-旧档.md', content: '---\n章号: 4\n标题: 旧档\n---\n\n内容。\n' })
    if (!created.ok) throw new Error('prereq')
    const abs = join(root, '写作/正文/0004-旧档.md')
    // 模拟他进程以 GBK 落盘（「旧档」GBK 双字节非合法 UTF-8 序列）
    const gbk = Buffer.concat([Buffer.from('---\n标题: ', 'utf-8'), Buffer.from([0xbe, 0xc9, 0xb5, 0xb5]), Buffer.from('\n---\n', 'utf-8')])
    writeFileSync(abs, gbk)
    const before = readFileSync(abs)
    const r = svc.updateDocMeta(created.docId, { 标题: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('非 UTF-8')
    expect(readFileSync(abs).equals(before)).toBe(true) // 原始字节零损伤
  })
})
