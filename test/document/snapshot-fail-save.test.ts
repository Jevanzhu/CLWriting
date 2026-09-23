/**
 * RC 源码重审 A-5（Opus-5.5 轮）回归：快照写失败不得阻断整次正文保存（留底 fail-open）。
 *
 * 故障面：executeSave 的 maybeSnapshot 原为裸调用、与正文原子写同处一个内层 try——
 * `工作区/.版本` 目录被同步盘锁住/只读/配额满时 writeVersion（真落盘段无 try/catch）
 * 抛出，直接落进下方 catch：journal 误记 aborted + 返回 WRITE_ERROR，正文一字未写却
 * 报失败。更糟的是 listVersions 对坏目录恒返 [] ⇒ 节流/去重判据永不生效 ⇒ 每笔保存
 * 都真去写、每笔都抛 = 作者永久写不进去的死锁（autosave 失败还不弹 toast）。
 *
 * 修复：留底是兜底不是闸（口径对齐 service-meta.ts R26-51 的 fail-open 先例）——warn
 * 留痕 + snapshotDegraded 旗随保存结果上抛，正文照常落盘（对齐 R75-4/R27-44 家族
 * 「写后 best-effort 副作用不得把成功改判失败」）。唯一不能碰的不变量：留底成功时其
 * 内容恒 === 被覆盖的盘上旧内容（R28-13），对照用例锁定之。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { DocumentService } from '../../src/document/service.js'
import { findUnsettled } from '../../src/document/journal.js'
import { listVersions, readVersion, encodeDocDirName, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'
import { log } from '../../src/log/index.js'

const relPath = '写作/正文/0001-开篇.md'
const OLD = '---\n标题: 开篇\n章号: 1\n---\n旧正文'
const NEW = '---\n标题: 开篇\n章号: 1\n---\n新正文'

describe('A-5: 快照写失败不阻断正文保存（留底 fail-open）', () => {
  let bookRoot: string
  let svc: DocumentService
  let absPath: string
  const docId = 'doc_a5'

  beforeEach(() => {
    bookRoot = mkdtempTracked(join(tmpdir(), 'a5-snap-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    absPath = join(bookRoot, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, OLD, 'utf-8')
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('`.版本` 是普通文件（mkdir 必败）→ 保存仍 ok:true + 正文落盘 + 无孤儿 pending + warn + snapshotDegraded', async () => {
    // 工作区/.版本 做成普通文件 → writeVersion 的 mkdir 必败（装置手法对齐
    // test/process/save-draft-guard.test.ts 的 Y-3 用例）
    writeFileSync(join(bookRoot, '工作区', VERSIONS_DIR_NAME), 'not-a-dir')
    const warnSpy = vi.spyOn(log, 'warn')
    const base = computeRevision(absPath)
    const r = await svc.save(docId, relPath, {
      content: NEW,
      expectedRevision: base,
      operationId: 'op-a5-1',
      origin: 'manual',
    })
    // 修复点：留底失败不再把「正文实际已落盘」的保存改判为 WRITE_ERROR
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.revision).toMatch(/^sha256:/)
    expect(r.snapshotDegraded).toBe(true)
    expect(readFileSync(absPath, 'utf-8')).toBe(NEW)
    // journal 收口干净：settled 已写，无孤立 pending（误报 crashedWrite 的反面证据）
    const journalPath = join(bookRoot, '工作区', '.journal', `${encodeDocDirName(docId)}.jsonl`)
    expect(findUnsettled(journalPath)).toHaveLength(0)
    // 降级可见：warn 留痕（点名原因与出路）
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('保存前版本留底失败'))).toBe(true)
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes(VERSIONS_DIR_NAME))).toBe(true)
  })

  it('旧版行为对照：连坏目录下多笔保存全部成功（节流失效不再放大成永久失败）', async () => {
    writeFileSync(join(bookRoot, '工作区', VERSIONS_DIR_NAME), 'not-a-dir')
    let rev = computeRevision(absPath)
    for (let i = 1; i <= 3; i++) {
      const next = `---\n标题: 开篇\n章号: 1\n---\n正文${i}`
      const r = await svc.save(docId, relPath, {
        content: next,
        expectedRevision: rev,
        operationId: `op-a5-loop-${i}`,
        origin: 'autosave',
      })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.snapshotDegraded).toBe(true)
      expect(readFileSync(absPath, 'utf-8')).toBe(next)
      rev = computeRevision(absPath)
    }
  })

  it('对照：`.版本` 健康 → 结果不含 snapshotDegraded，且留底内容 === 被覆盖的盘上旧文', async () => {
    const base = computeRevision(absPath)
    const r = await svc.save(docId, relPath, {
      content: NEW,
      expectedRevision: base,
      operationId: 'op-a5-ok',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    // 健康路径信封形状零改动（仅降级时才带该字段）
    expect(r.snapshotDegraded).toBeUndefined()
    expect(readFileSync(absPath, 'utf-8')).toBe(NEW)
    const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    const entries = listVersions(versionsDir, docId)
    expect(entries).toHaveLength(1)
    const snap = readVersion(versionsDir, docId, entries[0]!.id)!
    // R28-13 不变量：留底 = 被覆盖的旧内容（fail-open 不碰写成功路径）
    expect(snap.content).toBe(OLD)
    expect(snap.meta.baseRevision).toBe(base)
  })
})
