/**
 * R76（二十四轮修复批 A）：数据安全域回归。
 *
 * - R76-1：元数据 PATCH 双路径（updateChapterMeta/updateDocMeta）包 per-doc save 锁——
 *   他进程（本测试以同进程外持锁模拟跨进程持锁者）在持 → fail-closed 拒绝、文件一字
 *   不动；释放后恢复可用；正常路径锁不残留。
 * - R76-2：非章节文档普通保存留底「修改前」快照；同 origin 节流窗内二存不落新快照。
 * - R76-25：crashedWrite 健康报文带文档路径（清单在册首要标识，替代裸 docId）。
 * - R76-26：snapshotBeforeOverwrite 尊重 global.json snapMax* 保留策略（与编辑器保存链
 *   的 maybeSnapshot 同口径；此前落硬编码默认 14 天/30 版）。
 * - R76-27：purgeTrash 连删 journal 同名锁残留（无人持有才删，在持跳过）；
 *   sweepAbandonedTmpFiles 清死 pid 陈锁、不清活 pid/年轻锁/非锁指纹、跳过 .git。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DocumentService, __setMetaSaveLockTimeoutForTest } from '../../src/document/service.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { snapshotBeforeOverwrite } from '../../src/process/draft-pipeline.js'
import { listVersions, readVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { purgeTrash, appendTrashEntry } from '../../src/document/trash.js'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { appendPending } from '../../src/document/journal.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { computeRevision } from '../../src/document/revision.js'
import type { DocumentRole } from '../../src/document/layout.js'

let bookRoot = ''
beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r76-a-'))
})
afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  __setMetaSaveLockTimeoutForTest(5_000)
})

// ── R76-1：元数据 PATCH 包 save 锁 ───────────────────────────────

test('R76-1: 持锁期间 updateDocMeta fail-closed 拒绝且文件一字不动；释放后可用、锁不残留', async () => {
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({ relPath: '设定/世界观.md', content: '---\n名称: A\n---\n第一版' })
  if (!c.ok) throw new Error('prereq create')
  __setMetaSaveLockTimeoutForTest(150)
  const lockPath = join(bookRoot, '工作区', '.journal', `${c.docId}.jsonl.save.lock`)
  const release = acquireCrossProcessLockWithTimeout(lockPath, 0)
  expect(release).not.toBeNull()
  const before = readFileSync(join(bookRoot, '设定/世界观.md'), 'utf-8')
  const r = await svc.updateDocMeta(c.docId, { 名称: 'B' })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('元数据保存等待超时')
  }
  expect(readFileSync(join(bookRoot, '设定/世界观.md'), 'utf-8')).toBe(before)
  release!()
  const r2 = await svc.updateDocMeta(c.docId, { 名称: 'B' })
  expect(r2.ok).toBe(true)
  expect(existsSync(lockPath)).toBe(false)
})

test('R76-1: 持锁期间 updateChapterMeta 同款拒绝（含尾部 rename 不发生）', async () => {
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-开篇.md',
    content: '---\n标题: 开篇\n章号: 1\n---\n正文',
  })
  if (!c.ok) throw new Error('prereq create')
  __setMetaSaveLockTimeoutForTest(150)
  const lockPath = join(bookRoot, '工作区', '.journal', `${c.docId}.jsonl.save.lock`)
  const release = acquireCrossProcessLockWithTimeout(lockPath, 0)
  expect(release).not.toBeNull()
  const r = await svc.updateChapterMeta(c.docId, { 标题: '新标题' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
  expect(existsSync(join(bookRoot, '写作/正文/0001-开篇.md'))).toBe(true)
  expect(existsSync(join(bookRoot, '写作/正文/0001-新标题.md'))).toBe(false)
  release!()
})

// ── R76-2：非章节文档保存留底 ───────────────────────────────────

test('R76-2: 非章节文档普通保存留「修改前」快照；节流窗内二存不落新快照', async () => {
  const svc = new DocumentService({ bookRoot })
  const rel = '设定/世界观.md'
  const c = await svc.createDocument({ relPath: rel, content: '---\n名称: A\n---\n第一版' })
  if (!c.ok) throw new Error('prereq create')
  const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  const rev1 = computeRevision(join(bookRoot, rel))
  const s1 = await svc.save(c.docId, rel, {
    content: '---\n名称: A\n---\n第二版',
    expectedRevision: rev1,
    operationId: 'op-r76-2a',
    origin: 'manual',
  })
  expect(s1.ok).toBe(true)
  const after1 = listVersions(versionsDir, c.docId)
  expect(after1.length).toBe(1)
  const snap = readVersion(versionsDir, c.docId, after1[0]!.id)
  expect(snap?.content).toContain('第一版')
  expect(snap?.meta.reason).toBe('修改前留底（R76-2）')
  // 节流窗内（同 origin manual，5 分钟）第二次保存不落新快照
  const rev2 = computeRevision(join(bookRoot, rel))
  const s2 = await svc.save(c.docId, rel, {
    content: '---\n名称: A\n---\n第三版',
    expectedRevision: rev2,
    operationId: 'op-r76-2b',
    origin: 'manual',
  })
  expect(s2.ok).toBe(true)
  expect(listVersions(versionsDir, c.docId).length).toBe(1)
})

// ── R76-25：crashedWrite 报文带路径 ──────────────────────────────

test('R76-25: crashedWrite 健康报文以清单路径为首要标识（不再裸报 docId）', async () => {
  mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
  const mp = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  upsertEntry(m, { id: 'doc_r25', nodeType: 'document', path: '设定/人物.md', parentId: null })
  writeManifest(mp, m)
  await appendPending(join(bookRoot, '工作区', '.journal', 'doc_r25.jsonl'), 'doc_r25', null, 'lost content')
  const d = await detectState(bookRoot, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  const crashed = d.issues.find((i) => i.kind === 'crashedWrite')
  expect(crashed).toBeDefined()
  expect(crashed!.humanMsg).toContain('设定/人物.md')
})

// ── R76-26：覆写留底走全局保留策略 ───────────────────────────────

test('R76-26: snapshotBeforeOverwrite 按 global.json snapMaxCount 修剪；缺省回落默认 30', () => {
  const userData = mkdtempSync(join(tmpdir(), 'clw-r76-ud-'))
  writeFileSync(join(userData, 'global.json'), JSON.stringify({ snapMaxCount: 1, snapMaxDays: 14 }))
  const rel = '工作区/细纲.md'
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, rel), '内容一')
  const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  snapshotBeforeOverwrite(bookRoot, rel, '内容二', 'r76-26-test', undefined, userData)
  writeFileSync(join(bookRoot, rel), '内容二')
  snapshotBeforeOverwrite(bookRoot, rel, '内容三', 'r76-26-test', undefined, userData)
  // docId = legacyId(工作区/细纲.md)——从版本目录反查唯一子目录
  const docDirs = existsSync(versionsDir) ? readdirSync(versionsDir) : []
  expect(docDirs.length).toBe(1)
  expect(listVersions(versionsDir, docDirs[0]!).length).toBe(1) // snapMaxCount=1：旧版被 prune
  rmSync(userData, { recursive: true, force: true })
  // 对照：无 userDataPath → 默认策略（30 版）→ 两版都在
  const book2 = mkdtempSync(join(tmpdir(), 'clw-r76-b2-'))
  try {
    const rel2 = '工作区/细纲.md'
    mkdirSync(join(book2, '工作区'), { recursive: true })
    writeFileSync(join(book2, rel2), '内容一')
    snapshotBeforeOverwrite(book2, rel2, '内容二', 'r76-26-test')
    writeFileSync(join(book2, rel2), '内容二')
    snapshotBeforeOverwrite(book2, rel2, '内容三', 'r76-26-test')
    const dirs2 = readdirSync(join(book2, '工作区', VERSIONS_DIR_NAME))
    expect(dirs2.length).toBe(1)
    expect(listVersions(join(book2, '工作区', VERSIONS_DIR_NAME), dirs2[0]!).length).toBe(2)
  } finally {
    rmSync(book2, { recursive: true, force: true })
  }
})

// ── R76-27：锁残留卫生 ──────────────────────────────────────────

test('R76-27→R39-12: purge 删 journal；锁残留一律不删（陈锁清扫归 sweep 确定性判据）', async () => {
  const id = 'doc_r27'
  const jdir = join(bookRoot, '工作区', '.journal')
  mkdirSync(jdir, { recursive: true })
  const journalFile = join(jdir, `${id}.jsonl`)
  const lockResidue = `${journalFile}.save.lock`
  writeFileSync(journalFile, '')
  // 死 pid（远超系统 pid 上限，kill 探测恒 ESRCH）且无人会再获取——孤儿锁形态
  writeFileSync(lockResidue, JSON.stringify({ pid: 999_999_99, bootTime: 0 }))
  appendTrashEntry(bookRoot, {
    id,
    originalPath: '设定/x.md',
    trashedPath: '工作区/.trash/doc_r27-x.md',
    trashedAt: '',
    role: 'setting' as DocumentRole,
  })
  const p1 = await purgeTrash(bookRoot, id)
  expect(p1.ok).toBe(true)
  expect(existsSync(journalFile)).toBe(false)
  // R39-12（三十九轮）：purge 不再自删锁残留——原「queryLockHeld → rmSync」有 µs 级
  // TOCTOU（判「不在持」与删之间他进程恰完成取锁复核，删在持锁 = 互斥失效）。孤儿锁
  // 归 sweepAbandonedTmpFiles 的 .lock 分支确定性判据（合法锁指纹 + pid 死亡 + 10min
  // 超龄，healthCheck 接线）清扫，宁慢勿错；本例死 pid 但 mtime 年轻，sweep 也不清，
  // 残留无害
  expect(existsSync(lockResidue)).toBe(true)
  // 在持锁：同样不删（「在持跳过」语义由「一律不删」自然包含）
  writeFileSync(journalFile, '')
  const release = acquireCrossProcessLockWithTimeout(lockResidue, 0)
  expect(release).not.toBeNull()
  appendTrashEntry(bookRoot, {
    id,
    originalPath: '设定/x.md',
    trashedPath: '工作区/.trash/doc_r27-x.md',
    trashedAt: '',
    role: 'setting' as DocumentRole,
  })
  const p2 = await purgeTrash(bookRoot, id)
  expect(p2.ok).toBe(true)
  expect(existsSync(journalFile)).toBe(false)
  expect(existsSync(lockResidue)).toBe(true)
  release!()
})

test('R76-27: sweep 清死 pid 陈锁；活 pid/年轻锁/非锁指纹不清；跳过 .git', () => {
  const dir = bookRoot
  const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  expect(deadChild.status).toBe(0)
  // spawnSync 返回 pid 类型含 undefined（防御：拿不到就退回超范围死 pid）
  const deadPid = deadChild.pid ?? 999_999_98
  const old = new Date(Date.now() - 20 * 60_000)
  // ① 死 pid + 超龄 → 清
  const stale = join(dir, 'stale.lock')
  writeFileSync(stale, JSON.stringify({ pid: deadPid, bootTime: 0 }))
  utimesSync(stale, old, old)
  // ② 活 pid（本进程）→ 不清（删在持锁 = 互斥失效）
  const live = join(dir, 'live.lock')
  writeFileSync(live, JSON.stringify({ pid: process.pid, bootTime: 0 }))
  utimesSync(live, old, old)
  // ③ 死 pid 但年轻 → 不清（年龄门）
  const young = join(dir, 'young.lock')
  writeFileSync(young, JSON.stringify({ pid: deadPid, bootTime: 0 }))
  // ④ 非 JSON 锁指纹（作者手放同名文件）→ 不清
  const notLock = join(dir, 'notes.lock')
  writeFileSync(notLock, '# 手写笔记，不是锁\n')
  // ⑤ .git 内的死 pid 陈锁 → 不清（跳过目录）
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
  const gitLock = join(dir, '.git', 'objects', 'stale.lock')
  writeFileSync(gitLock, JSON.stringify({ pid: deadPid, bootTime: 0 }))
  utimesSync(gitLock, old, old)
  const removed = sweepAbandonedTmpFiles(dir, { minAgeMs: 5 * 60_000 })
  expect(removed).toBe(1)
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(existsSync(young)).toBe(true)
  expect(existsSync(notLock)).toBe(true)
  expect(existsSync(gitLock)).toBe(true)
})
