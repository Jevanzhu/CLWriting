/**
 * R0912-3（2026-09-12 全量重评 P2-2）回归：doTrash 定稿基线快照与清单条目删除之间
 * 无互斥，覆盖 finalize 链。
 *
 * 机理：doTrash 无锁快照 priorFinalized（只持 per-doc save 锁，finalize 不持该锁）→
 * TrashEntry 按快照落账 → 清单锁内新鲜读**整条 delete**。并发时序「doTrash 读快照 A
 * （无基线）→ finalize 写入基线 → 删除 RMW 把带基线条目整条删掉」→ TrashEntry 记的
 * 还是快照 A → 还原后该章无定稿基线，ensureChapterNotFinalized 防覆盖闸失守
 * （tags/order 同窗同失）。
 *
 * 修复：删除 RMW 锁内 strict 新鲜读条目，基线投影与快照不一致时先回填 TrashEntry
 * 再 delete（TrashEntry 落账与清单删除收进同一清单锁临界段）。无并发时新鲜读与
 * 快照恒等 → 不重写条目，行为逐字节不变（本文件对照用例钉定）。
 *
 * 时序闸门：测试持回收站登记锁（<trash-manifest>.lock）把 doTrash 闸在其首次
 * appendTrashEntryAsync 处——该 await 之前与「删除前留底」同处一段同步代码（留底
 * 与基线快照之间无让出点），观测到 .版本/<docId> 落盘即快照已定格；随后放 finalize
 * 写基线，再放行 doTrash，精确复现「快照后、删除前」窗口（r0912-interrupt-semantics
 * 可控闸门同款手法）。
 */
import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { finalizeRevisionAsync } from '../../src/document/finalize.js'
import { listTrash, restoreTrash } from '../../src/document/trash.js'
import { readManifest } from '../../src/document/manifest.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { resolveDraftPath } from '../../src/format/draft.js'

let bookRoot: string

afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

/** 造书：写作/正文/第一卷/0001 + 清单登记 doc_ch01（无基线；基线由用例自写/经 finalize 写）。 */
function makeBook(prefix: string): { svc: DocumentService; manifestPath: string } {
  bookRoot = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(bookRoot, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n初稿正文', 'utf-8')
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  writeManifestLines(manifestPath, [
    '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null}',
  ])
  return { svc: new DocumentService({ bookRoot }), manifestPath }
}

function writeManifestLines(manifestPath: string, lines: string[]): void {
  writeFileSync(manifestPath, ['{"version":1,"type":"header"}', ...lines].join('\n') + '\n', 'utf-8')
}

/** r0912-interrupt-semantics 同款轮询闸：cond 就绪即返回，超时 fail-loud。 */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) {
    await new Promise((r) => setImmediate(r))
  }
  if (!cond()) throw new Error(`等待超时：${what}`)
}

it('R0912-3: 快照后、删除前 finalize 写基线 → 删除 RMW 锁内回填 TrashEntry，还原后防线成立', async () => {
  const { svc, manifestPath } = makeBook('r0912-3-race-')
  // ① 持回收站登记锁——doTrash 将闸在首次 TrashEntry 落账处（基线快照已在同段同步代码里定格为无基线）
  const trashLockPath = join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl.lock')
  const releaseTrashLock = acquireCrossProcessLockWithTimeout(trashLockPath, 5_000)
  expect(releaseTrashLock).not.toBeNull()
  const tp = svc.trashDocument({ docId: 'doc_ch01' })
  // ② 观测删除前留底落盘 = 快照已读（留底与快照间无让出点，其后首个 await 即闸在登记锁）
  await until(() => existsSync(join(bookRoot, '工作区', '.版本', 'doc_ch01')), 'doTrash 到达删除前留底')
  // ③ 窗口内并发 finalize：持清单锁写入定稿基线（finalize 不持 doTrash 的 save 锁）
  const fr = await finalizeRevisionAsync(bookRoot, 'doc_ch01')
  expect(fr.ok).toBe(true)
  const finalized = readManifest(manifestPath).entries.get('doc_ch01')
  expect(finalized?.finalizedRevision).toBeTruthy()
  // ④ 放行 doTrash：TrashEntry 按旧快照落账 → 删除 RMW 锁内新鲜读回填基线后整条删
  releaseTrashLock!()
  const tr = await tp
  expect(tr.ok).toBe(true)
  // ⑤ 回收站条目带当次基线（修复前按无基线快照落账 → 此处红）
  const entries = listTrash(bookRoot)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.finalizedRevision).toBe(finalized?.finalizedRevision)
  expect(entries[0]!.finalizedAt).toBe(finalized?.finalizedAt)
  expect(readManifest(manifestPath).entries.has('doc_ch01')).toBe(false)
  // ⑥ 还原 → 清单条目带回基线，ensureChapterNotFinalized 防覆盖闸重新生效（W-P2-1 链路级断言同款）
  const rr = await restoreTrash(bookRoot, 'doc_ch01')
  expect(rr.ok).toBe(true)
  const restored = readManifest(manifestPath).entries.get('doc_ch01')
  expect(restored?.finalizedRevision).toBe(finalized?.finalizedRevision)
  expect(() => resolveDraftPath(bookRoot, 1)).toThrow(/已定稿/)
})

it('R0912-3 对照：无并发 + 从未定稿 → 条目恰为基座五键、无基线投影字段（行为不变）', async () => {
  const { svc } = makeBook('r0912-3-nobase-')
  const tr = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(tr.ok).toBe(true)
  const entries = listTrash(bookRoot)
  expect(entries).toHaveLength(1)
  // 删除 RMW 锁内新鲜读与快照恒等 → 不重写条目；基线字段缺席 = 「从未定稿」原语义
  expect(entries[0]).toEqual({
    id: 'doc_ch01',
    originalPath: '写作/正文/第一卷/0001-开篇.md',
    trashedAt: entries[0]!.trashedAt,
    role: 'chapter',
    trashedPath: '工作区/.trash/doc_ch01-0001-开篇.md',
  })
})

it('R0912-3 对照：无并发 + 已定稿（含 tags/order）→ 条目逐字节同快照投影（键序不变）', async () => {
  const { svc, manifestPath } = makeBook('r0912-3-withbase-')
  writeManifestLines(manifestPath, [
    '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,' +
      '"finalizedRevision":"sha256:baseline-1","finalizedAt":"2026-01-01T00:00:00Z","tags":["卷一"],"order":3}',
  ])
  const tr = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(tr.ok).toBe(true)
  // 逐字节钉定：键序 = 条目基座（id/originalPath/trashedAt/role）→ 基线投影 → trashedPath，
  // 与修复前 append 形态一致（无并发不触发回填重写）
  const raw = readFileSync(join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl'), 'utf-8').trim()
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const expected = JSON.stringify({
    id: 'doc_ch01',
    originalPath: '写作/正文/第一卷/0001-开篇.md',
    trashedAt: parsed.trashedAt,
    role: 'chapter',
    finalizedRevision: 'sha256:baseline-1',
    finalizedAt: '2026-01-01T00:00:00Z',
    tags: ['卷一'],
    order: 3,
    trashedPath: '工作区/.trash/doc_ch01-0001-开篇.md',
  })
  expect(raw).toBe(expected)
  // 还原带回全部投影字段（基线 + R27-47 tags/order）
  const rr = await restoreTrash(bookRoot, 'doc_ch01')
  expect(rr.ok).toBe(true)
  expect(readManifest(manifestPath).entries.get('doc_ch01')).toMatchObject({
    finalizedRevision: 'sha256:baseline-1',
    finalizedAt: '2026-01-01T00:00:00Z',
    tags: ['卷一'],
    order: 3,
  })
})
