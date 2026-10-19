/**
 * W2A T5 —— 回收站（DocumentService.trashDocument + trash.ts restore/purge/list）单测。
 * 覆盖：软删（移 .trash + 清单移除 + manifest 记录）、账本 CAPABILITY_DENIED、NOT_FOUND、
 * 恢复（移回 + 清单恢复）、原位占用 OCCUPIED、永久删、listTrash。
 */
import { test, expect, vi, describe } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { listTrash, restoreTrash, purgeTrash, readTrashManifest, appendTrashEntry } from '../../src/document/trash.js'
import { waitFor } from '../helpers/wait-for.js'

// purge 条目写回 best-effort 注入：atomicWriteFile 只对回收站清单一次性失败。默认不武装
// （由对应用例内显式 arm/disarm），避免与同文件其他用例的回收站清单写入互相干扰。
const ATOMIC_FAIL = vi.hoisted(() => ({ failNextTrashWrite: false }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...orig,
    atomicWriteFile: vi.fn((p: string, data: string, opts?: { fsync?: boolean }) => {
      if (ATOMIC_FAIL.failNextTrashWrite && p.includes('.trash-manifest.jsonl')) {
        ATOMIC_FAIL.failNextTrashWrite = false
        throw Object.assign(new Error('EACCES: 权限不足（模拟磁盘故障）'), { code: 'EACCES' })
      }
      return orig.atomicWriteFile(p, data, opts)
    }),
  }
})

// purgeTrash 条目定位 strict 读注入：默认不武装（本文件其余用例的回收站清单读写全透传），
// 由对应用例内显式 arm（vi.hoisted + importOriginal 透传手法与既有注入族同款）。
const FAIL = vi.hoisted(() => ({ manifestRead: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p: Parameters<typeof readFileSync>[0], ...rest: any[]) => {
      if (FAIL.manifestRead && typeof p === 'string' && p.includes('.trash-manifest.jsonl')) {
        throw Object.assign(new Error('EBUSY: 瞬时占用（模拟同步盘扫描锁）'), { code: 'EBUSY' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

/** 造书：写作/正文/第一卷/0001 + 项目清单登记 doc_ch01。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', {
    cwd: root,
    stdio: 'pipe',
  })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('trashDocument: 软删 → 移 .trash + 清单移除 + manifest 记录', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.trashedPath).toBe('工作区/.trash/doc_ch01-0001-开篇.md')
  expect(existsSync(join(root, r.trashedPath))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).not.toContain('doc_ch01')
  const trash = listTrash(root)
  expect(trash).toHaveLength(1)
  expect(trash[0]!.id).toBe('doc_ch01')
  expect(trash[0]!.originalPath).toBe('写作/正文/第一卷/0001-开篇.md')
  expect(trash[0]!.role).toBe('chapter')
  rmSync(root, { recursive: true, force: true })
})

test('trashDocument: 账本（ledger trash=false）→ CAPABILITY_DENIED', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-lg-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', {
    cwd: root,
    stdio: 'pipe',
  })
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', '001-玉佩.md'), '---\n---\n悬念', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_lg01","nodeType":"document","path":"布线/悬念/001-玉佩.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const svc = new DocumentService({ bookRoot: root })
  const r = await svc.trashDocument({ docId: 'doc_lg01' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  // 原文件未动
  expect(existsSync(join(root, '布线', '悬念', '001-玉佩.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('trashDocument: 未登记 docId → NOT_FOUND', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_unknown' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 恢复 → 移回原位 + 清单恢复 + manifest 移除', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0001-开篇.md')
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 原位已被占用 → OCCUPIED（不自动改名，§17 决策④）', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  // 原位新建同名文件（占用）
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '新的内容', 'utf-8')
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('OCCUPIED')
  // trash 条目仍在（未恢复成功）
  expect(listTrash(root)).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 回收站无此 id → NOT_FOUND', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-empty-'))
  const r = await restoreTrash(root, 'doc_xxx')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('R41-9: 续传补录——文件已回原位且 .trash 侧已清的中间态，重试补清单并清条目（不再恒 NOT_FOUND）', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  // 构造 R33-10 中间态：物理恢复已完成（文件移回原位、.trash 侧无文件），但上次
  // 清单 upsert 失败 → 清单仍无 doc_ch01、回收站条目仍在。修复前重试恒
  // NOT_FOUND「回收站文件已丢失」→ 条目永久悬置、docId 断链无法自愈
  const { renameSync } = await import('node:fs')
  renameSync(join(root, '工作区/.trash/doc_ch01-0001-开篇.md'), join(root, '写作/正文/第一卷/0001-开篇.md'))
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0001-开篇.md')
  // 清单补录到位 + 条目移除 + 原位文件原样
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
  expect(listTrash(root)).toHaveLength(0)
  expect(existsSync(join(root, '写作/正文/第一卷/0001-开篇.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('R41-9: 中间态之外——原位也无文件 → 仍 NOT_FOUND（不凭空补录）', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  rmSync(join(root, '工作区/.trash/doc_ch01-0001-开篇.md'))
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  expect(listTrash(root)).toHaveLength(1) // 条目保留（无从判定恢复完成）
  rmSync(root, { recursive: true, force: true })
})

test('purgeTrash: 永久删 → 物理删文件 + manifest 移除', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  const trashedAbs = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
  expect(existsSync(trashedAbs)).toBe(true)
  const r = await purgeTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  expect(existsSync(trashedAbs)).toBe(false)
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('listTrash: 空回收站 → []', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-list-'))
  expect(listTrash(root)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

// ── W-P2-1：定稿基线随回收站条目往返 ────────────────

test('W-P2-1：软删已定稿章 → 回收站条目带基线；恢复后清单还原基线，定稿防线重新生效', async () => {
  const { root, svc } = makeBookWithChapter()
  // 清单补定稿基线（makeBookWithChapter 默认只写 status: final）
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  writeFileSync(
    manifestPath,
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"finalizedRevision":"sha256:baseline-1","finalizedAt":"2026-01-01T00:00:00Z"}',
    ].join('\n') + '\n',
    'utf-8',
  )

  const tr = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(tr.ok).toBe(true)
  // 回收站条目带定稿基线
  const entries = listTrash(root)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.finalizedRevision).toBe('sha256:baseline-1')

  const rr = await restoreTrash(root, 'doc_ch01')
  expect(rr.ok).toBe(true)
  // 恢复后清单条目带回基线（修复前：upsertEntry 不带基线 → 已定稿章降级草稿态）
  const { readManifest } = await import('../../src/document/manifest.js')
  const m = readManifest(manifestPath)
  expect(m.entries.get('doc_ch01')?.finalizedRevision).toBe('sha256:baseline-1')

  // 链路级断言：定稿防线（V-P1-3 + W-P2-2）对恢复章重新生效——续写第 1 章应被拒绝
  const { resolveDraftPath } = await import('../../src/document/draft-path.js')
  expect(() => resolveDraftPath(root, 1)).toThrow(/已定稿/)
  rmSync(root, { recursive: true, force: true })
})

// ── R65-36（第六十五轮）：restore 重入幂等——「link 成功 → 删源」间崩溃的续跑 ────

test('R65-36: 目标位与回收站双份（link 后未删源崩溃形态）→ 再还原视为已完成：删源+清单收口，不再 OCCUPIED 卡死', async () => {
  const { root, svc } = makeBookWithChapter()
  try {
    await svc.trashDocument({ docId: 'doc_ch01' })
    // 手动造双份：模拟上次 restore 在 linkSync 成功后、rmSync 源之前崩溃
    // （link 的硬链接与 trash 源同 inode，内容天然一致）
    const trashAbs = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
    const origAbs = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
    linkSync(trashAbs, origAbs)
    expect(existsSync(origAbs)).toBe(true) // 双份在位
    // 修复前：此处 OCCUPIED 卡死（每次还原都撞占用，条目永不清）
    const r = await restoreTrash(root, 'doc_ch01')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 源被清、目标保留、清单恢复、条目移除
    expect(existsSync(trashAbs)).toBe(false)
    expect(existsSync(origAbs)).toBe(true)
    expect(readFileSync(origAbs, 'utf-8')).toContain('正文')
    expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
    expect(listTrash(root)).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R65-36: 目标位是作者另建的不同内容 → 仍 OCCUPIED（内容比对不一致不误吞作者文件）', async () => {
  const { root, svc } = makeBookWithChapter()
  try {
    await svc.trashDocument({ docId: 'doc_ch01' })
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '作者完全不同的新内容', 'utf-8')
    const r = await restoreTrash(root, 'doc_ch01')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('OCCUPIED')
    expect(listTrash(root)).toHaveLength(1) // 条目保留
    expect(readFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), 'utf-8')).toBe('作者完全不同的新内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R67-11（十五轮）：doTrash 入口 safeDocId 纵深守卫 ──────────────

test('R67-11: 恶意 docId（manifest 篡改数据面）→ PATH_ESCAPE，不进 snapshot/trash 链', async () => {
  const { root, svc } = makeBookWithChapter()
  // 清单被篡改：登记一条带穿越形态 id 的条目（safeDocId 应在入口拦下，
  // 而非依赖下游 resolveSafePath 兜底）
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"../../evil","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const r = await svc.trashDocument({ docId: '../../evil' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
  // 原文件无损，回收站/快照无穿越产物
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  expect(existsSync(join(root, '工作区', '.trash'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

// ── purgeTrash 条目定位读改 strict：此前用容错版 readTrashManifest（读失败返 []），
// 瞬态读失败（EBUSY/EACCES/EIO）会把在册条目误判 NOT_FOUND（作者以为没删成、条目悬置
// 成幽灵）。修复后走 readTrashManifestStrict，strict 读失败按 WRITE_ERROR 信封如实上报
// （物理删除未发生，不可逆动作未成，重试即续）。──

describe('purgeTrash 清单 strict 读', () => {
  function makeTrashedBook(): string {
    const root = mkdtempTracked(join(tmpdir(), 'clw-r49-16-purge-'))
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'), '旧内容', 'utf-8')
    writeFileSync(
      join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
      JSON.stringify({
        id: 'doc_a',
        originalPath: '写作/正文/0001-旧稿.md',
        trashedPath: '工作区/.trash/doc_a-旧稿.md',
        trashedAt: '',
        role: 'chapter',
      }) + '\n',
      'utf-8',
    )
    return root
  }

  test('清单瞬态读失败 → WRITE_ERROR（不再误报 NOT_FOUND），物理删除不发生', async () => {
    FAIL.manifestRead = true // 本用例专属武装：读侧注入一次瞬态占用
    const root = makeTrashedBook()
    try {
      const trashFile = join(root, '工作区', '.trash', 'doc_a-旧稿.md')
      const r = await purgeTrash(root, 'doc_a')
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('WRITE_ERROR') // 修复前：容错读返 [] → 误报 NOT_FOUND
      expect(r.reason).toContain('回收站清单读取失败')
      expect(existsSync(trashFile)).toBe(true) // 不可逆动作未成（重试即续）
      FAIL.manifestRead = false // 解除 mock 故障后再验证条目未动（本文件自身读也走 mock）
      expect(readTrashManifest(root)).toHaveLength(1)
      // 瞬态恢复后重试 → 正常永久删（非死路）
      const retry = await purgeTrash(root, 'doc_a')
      expect(retry.ok).toBe(true)
      expect(existsSync(trashFile)).toBe(false)
      expect(readTrashManifest(root)).toHaveLength(0)
    } finally {
      FAIL.manifestRead = false
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('在册可读时 NOT_FOUND 契约不变（未知 id）', async () => {
    const root = makeTrashedBook()
    try {
      const r = await purgeTrash(root, 'doc_none')
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('NOT_FOUND')
      expect(existsSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── restore/purge 的清单写回段隔着跨进程清单锁 await——书可在「端点入口守卫已过、
// 锁等待窗」内被整目录删除。修复后写回锁回调首行做回收站清单在位复评，死书弃写回
// （best-effort catch 留痕），不在死书残骸上重建清单与回收站条目文件。──

describe('trash 写回段死书弃收口', () => {
  function makeBookWithChapter(): { root: string; svc: DocumentService } {
    const root = mkdtempTracked(join(tmpdir(), 'clw-trash-deadbook-'))
    execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', {
      cwd: root,
      stdio: 'pipe',
    })
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        '{"version":1,"type":"header"}',
        '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"draft"}',
      ].join('\n') + '\n',
    )
    execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
    return { root, svc: new DocumentService({ bookRoot: root }) }
  }

  /** 预持清单锁（本进程 pid → 活性探测恒存活，等待者持续轮询）。 */
  function holdLock(target: string): void {
    writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }))
  }

  test('restore：清单锁等待窗内书被整删 → 弃写回，不重建孤儿文档清单', async () => {
    const { root, svc } = makeBookWithChapter()
    const trashed = await svc.trashDocument({ docId: 'doc_ch01' })
    expect(trashed.ok).toBe(true)

    holdLock(join(root, '项目', '文档清单.jsonl'))
    const restoring = restoreTrash(root, 'doc_ch01')

    // 物理搬运（锁前同步段）完成 = 正卡在清单锁等待窗：原位文件已回
    const origAbs = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
    await waitFor(() => existsSync(origAbs), 4000, 10, 'restore 到达清单锁等待窗')

    // 窗内整删书目录（.lock 随目录消失 = 释放等待者）
    rmSync(root, { recursive: true })
    const r = await restoring
    expect(r.ok).toBe(true) // 物理恢复已发生，收口段弃写回不反悔

    // 修复前：锁回调在死书残骸上写孤儿文档清单（134b：头 + doc 条目）+ 0b 空回收站清单
    // 修复后：回调首行书身份锚复评（book.yaml ENOENT-only）弃写回，两个清单文件都不得重建
    expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(false)
    expect(existsSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))).toBe(false)
  })

  test('purge：条目写回锁窗内书被整删 → strict 读先弃，不重建回收站清单', async () => {
    const { root, svc } = makeBookWithChapter()
    const trashed = await svc.trashDocument({ docId: 'doc_ch01' })
    expect(trashed.ok).toBe(true)

    const trashFile = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
    expect(existsSync(trashFile)).toBe(true)

    holdLock(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))
    const purging = purgeTrash(root, 'doc_ch01')

    // 物理删除（锁前同步段）完成 = 正卡在条目写回锁等待窗
    await waitFor(() => !existsSync(trashFile), 4000, 10, 'purge 到达条目写回锁等待窗')

    rmSync(root, { recursive: true })
    const r = await purging
    expect(r.ok).toBe(true)
    // 修复前实证：缺失按合法空读（[]）+ 取锁 mkdir 复活祖先链 → 死书面「成功」写出 0b
    // 空清单；修复后回调首行书身份锚复评弃写——回收站清单文件不得重建
    expect(existsSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))).toBe(false)
  })
})

// ── purgeTrash 条目写回 best-effort：主文件已物理删除（不可逆动作已成）后，trash
// manifest 写失败（磁盘满/权限）不应把整端点打成 500——吞掉写失败仍返回 ok:true；
// 残留条目下次对该 id 操作报 NOT_FOUND 自愈。──

describe('purgeTrash 条目写回 best-effort', () => {
  function makeTrashedBook(): string {
    const root = mkdtempTracked(join(tmpdir(), 'clw-trash-purge-be-'))
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'), '旧内容', 'utf-8')
    writeFileSync(
      join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
      JSON.stringify({
        id: 'doc_a',
        originalPath: '写作/正文/0001-旧稿.md',
        trashedPath: '工作区/.trash/doc_a-旧稿.md',
        trashedAt: '',
        role: 'chapter',
      }) + '\n',
      'utf-8',
    )
    return root
  }

  test('条目写失败 → best-effort ok:true，物理删除照发生', async () => {
    ATOMIC_FAIL.failNextTrashWrite = true // 只失败一次：先证「写失败不上抛」，再证残留条目自愈
    const root = makeTrashedBook()
    try {
      const r = await purgeTrash(root, 'doc_a')
      expect(r.ok).toBe(true) // 修复前：writeTrashManifest 的 EACCES 直接上抛（端点 500）
      expect(existsSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'))).toBe(false) // 不可逆动作已发生
      expect(readTrashManifest(root).some((e) => e.id === 'doc_a')).toBe(true) // 条目残留（写失败未除名）
      // 残留自愈：磁盘恢复后再次 purge → 条目正常除名；此后该 id 报 NOT_FOUND
      expect((await purgeTrash(root, 'doc_a')).ok).toBe(true)
      expect(readTrashManifest(root).some((e) => e.id === 'doc_a')).toBe(false)
      const third = await purgeTrash(root, 'doc_a')
      expect(third.ok).toBe(false)
      if (third.ok) return
      expect(third.code).toBe('NOT_FOUND')
    } finally {
      ATOMIC_FAIL.failNextTrashWrite = false
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A-7：不可逆动作（主文件已物理删除）后的条目残留此前零留痕——补 warn 后
  // 「已永久删除但条目仍在册」可诊断（口径同恢复链的清单登记失败）。
  test('条目写回失败 → warn 留痕（不可逆动作已成，须可诊断）', async () => {
    const { log } = await import('../../src/log/index.js')
    const warn = vi.spyOn(log, 'warn')
    ATOMIC_FAIL.failNextTrashWrite = true
    const root = makeTrashedBook()
    try {
      const r = await purgeTrash(root, 'doc_a')
      expect(r.ok).toBe(true) // best-effort 语义不变：写失败不上抛
      expect(warn.mock.calls.flat().map(String).join(' ')).toContain('清单条目移除失败')
    } finally {
      warn.mockRestore()
      ATOMIC_FAIL.failNextTrashWrite = false
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 章纲随迁批：无主章纲能力例外（判据 = 章号 ∈ 并入引用 ∪ 回收站正文章号集，
// 且无存活同号正文；见 outline-orphan.ts）——合并/删章留下的孤儿纲唯一清理口。──

describe('章纲随迁批: 无主章纲可删（能力例外）', () => {
  /** 造书：files 逐项 mkdir -p + 落盘（含项目/文档清单.jsonl）。 */
  function makeBook(files: Record<string, string>): { root: string; svc: DocumentService } {
    const root = mkdtempTracked(join(tmpdir(), 'clw-outline-exempt-'))
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf-8')
    }
    return { root, svc: new DocumentService({ bookRoot: root }) }
  }

  const OUTLINE_REL = '大纲/章纲/0002-第2章纲.md'
  const OUTLINE_FM = '---\n章号: 2\n标题: 第2章\n---\n\n第2章章纲'
  const MANIFEST_BASE = '{"version":1,"type":"header"}\n'

  test('并入去向证据（fm 并入 引用 + 无存活同号正文）→ 放行软删，条目 role=chapter-outline', async () => {
    const { root, svc } = makeBook({
      '写作/正文/第一卷/0001-第1章.md': '---\n章号: 1\n标题: 第1章\n并入: [2]\n---\n\n正文',
      [OUTLINE_REL]: OUTLINE_FM,
      '项目/文档清单.jsonl':
        MANIFEST_BASE +
        [
          '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-第1章.md","parentId":null}',
          '{"id":"doc_ol02","nodeType":"document","path":"大纲/章纲/0002-第2章纲.md","parentId":null}',
        ].join('\n') +
        '\n',
    })
    try {
      const r = await svc.trashDocument({ docId: 'doc_ol02' })
      expect(r.ok).toBe(true)
      expect(existsSync(join(root, OUTLINE_REL))).toBe(false)
      const entry = listTrash(root).find((e) => e.id === 'doc_ol02')
      expect(entry?.role).toBe('chapter-outline')
      expect(entry?.originalPath).toBe(OUTLINE_REL)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('删章去向证据：先拒（存活宿主）→ 删章后放行（删章作废的纲清理口）', async () => {
    const { root, svc } = makeBook({
      '写作/正文/第一卷/0002-第2章.md': '---\n章号: 2\n标题: 第2章\n---\n\n第2章正文',
      [OUTLINE_REL]: OUTLINE_FM,
      '项目/文档清单.jsonl':
        MANIFEST_BASE +
        [
          '{"id":"doc_ch02","nodeType":"document","path":"写作/正文/第一卷/0002-第2章.md","parentId":null}',
          '{"id":"doc_ol02","nodeType":"document","path":"大纲/章纲/0002-第2章纲.md","parentId":null}',
        ].join('\n') +
        '\n',
    })
    try {
      // 宿主存活：纲不可删
      const denied = await svc.trashDocument({ docId: 'doc_ol02' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('CAPABILITY_DENIED')
      // 删章（作废）→ 回收站留痕构成证据 → 纲放行
      expect((await svc.trashDocument({ docId: 'doc_ch02' })).ok).toBe(true)
      const allowed = await svc.trashDocument({ docId: 'doc_ol02' })
      expect(allowed.ok).toBe(true)
      expect(existsSync(join(root, OUTLINE_REL))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('无证据（计划前置纲）→ CAPABILITY_DENIED，原文件不动', async () => {
    const { root, svc } = makeBook({
      '写作/正文/第一卷/0001-第1章.md': '---\n章号: 1\n标题: 第1章\n---\n\n正文',
      [OUTLINE_REL]: OUTLINE_FM,
      '项目/文档清单.jsonl':
        MANIFEST_BASE +
        ['{"id":"doc_ol02","nodeType":"document","path":"大纲/章纲/0002-第2章纲.md","parentId":null}'].join('\n') +
        '\n',
    })
    try {
      const r = await svc.trashDocument({ docId: 'doc_ol02' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('CAPABILITY_DENIED')
      expect(existsSync(join(root, OUTLINE_REL))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('复号有存活宿主（回收站旧条目不构成放行）→ CAPABILITY_DENIED', async () => {
    const { root, svc } = makeBook({
      '写作/正文/第一卷/0002-第2章.md': '---\n章号: 2\n标题: 第2章\n---\n\n第2章新正文',
      [OUTLINE_REL]: OUTLINE_FM,
      '项目/文档清单.jsonl':
        MANIFEST_BASE +
        [
          '{"id":"doc_ch02","nodeType":"document","path":"写作/正文/第一卷/0002-第2章.md","parentId":null}',
          '{"id":"doc_ol02","nodeType":"document","path":"大纲/章纲/0002-第2章纲.md","parentId":null}',
        ].join('\n') +
        '\n',
    })
    try {
      // 历史删章留痕（同号旧章），但同号新章存活——宁拒勿错删
      appendTrashEntry(root, {
        id: 'doc_old02',
        originalPath: '写作/正文/第一卷/0002-旧.md',
        trashedPath: '工作区/.trash/doc_old02-0002-旧.md',
        trashedAt: '2026-01-01T00:00:00Z',
        role: 'chapter',
      })
      const r = await svc.trashDocument({ docId: 'doc_ol02' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('CAPABILITY_DENIED')
      expect(existsSync(join(root, OUTLINE_REL))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
