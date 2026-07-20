/**
 * DocumentService —— 文档保存协议编排（W0-1 §5）+ 结构性操作（W2A §7）。
 *
 * 统一文档写入入口：UI / AI / CLI 一律经此，保证并发安全 + 崩溃可恢复。
 *
 * save 编排（§5.2，每文档串行队列内执行）：
 *   预校验路径（拒 symlink/`..` 越出）+ 能力（只读文档拒写）
 *   → 入 per-docId 串行队列 → 队列内串行执行：
 *     revision 校验 → journal pending → 按策略 snapshot → atomic write+fsync
 *     → 算新 revision → 条件性更新清单 → journal settled
 *
 * 结构性操作（W2A §7：create/move/rename）：
 *   同步实现（renameSync/mkdirSync + 同步清单写），靠 Node 单线程微任务不交错保证
 *   清单原子性；不走 queue（与同 docId 的 save 并发时，最坏 save 撞 REVISION_CONFLICT
 *   返回，不损坏数据）。事务顺序：预检查 → snapshot 留底 → fs 操作 → 清单同步 →
 *   invalidateTreeIndex。结构性操作触发旧书建清单（W0-1 §4.2）。
 *
 * 冲突 / 能力不足 / 落盘失败 → 不落盘、journal 标 aborted（save）/ 返回 {ok:false,code}。
 * freeze(docId) 暂停该文档保存队列（定稿流程用，防 autosave 改文件使 confirm hash 失效）。
 * recover() 启动扫 journal，报 pending 无 settled/aborted（崩溃未结算）提示作者恢复。
 *
 * docId 是稳定 ID（队列/日志/清单 key），relPath 是落盘路径。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { computeRevision, type Revision } from './revision.js'
import { layoutOf } from './layout.js'
import { appendAborted, appendPending, appendSettled, findUnsettled, type JournalPending } from './journal.js'
import { writeSnapshot } from './snapshot.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from './manifest.js'
import { SaveQueue } from './queue.js'
import { generateDocId } from './stable-id.js'
import { invalidateTreeIndex } from './tree.js'
import { appendTrashEntry } from './trash.js'

/** 保存输入（W0-1 §5.1）。 */
export interface SaveDocumentInput {
  content: string
  /** 期望基线 revision；null = 新建（撞已有文件 → 冲突）。 */
  expectedRevision: Revision
  /** 幂等去重 id。 */
  operationId: string
  origin: 'manual' | 'autosave' | 'restore' | 'external-merge'
  reason?: string
}

export type SaveResult =
  | { ok: true; revision: `sha256:${string}` }
  | {
      ok: false
      code: 'REVISION_CONFLICT' | 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'WRITE_ERROR'
      reason: string
    }

/** 保存出队结果（含旧响应标记）。联合分配：保留 ok 判别标签，可正常 narrow。 */
export type SaveOutcome = SaveResult & { superseded: boolean }

/** 崩溃恢复报告：docId → 未结算的 pending 列表。 */
export interface UnsettledReport {
  docId: string
  pending: JournalPending[]
}

/** 新建文档输入（W2A §7）。 */
export interface CreateDocumentInput {
  /** 目标相对路径（含 .md 后缀）。 */
  relPath: string
  /** 初始内容；缺省生成最小 frontmatter。 */
  content?: string
}

/** 新建结果。 */
export type CreateResult =
  | { ok: true; docId: string; path: string; revision: `sha256:${string}` }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'ALREADY_EXISTS' | 'WRITE_ERROR'; reason: string }

/** 移动文档输入（章号不变，文件名保持——§11）。 */
export interface MoveDocumentInput {
  docId: string
  /** 目标目录（相对 bookRoot，无尾斜杠）。 */
  toDir: string
}

/** 重命名文档输入。 */
export interface RenameDocumentInput {
  docId: string
  /** 新文件名（含 .md 后缀）。 */
  newName: string
}

/** 移动/重命名结果。 */
export type MoveResult =
  | { ok: true; docId: string; path: string }
  | {
      ok: false
      code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'WRITE_ERROR'
      reason: string
    }

/** 软删结果。 */
export type TrashResult =
  | { ok: true; docId: string; trashedPath: string }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'WRITE_ERROR'; reason: string }

export interface DocumentServiceOptions {
  bookRoot: string
  /** 注入队列（测试桩）；默认新建 per-docId 串行队列。 */
  queue?: SaveQueue<SaveResult>
}

/** 文档保存服务（绑定 bookRoot）。 */
export class DocumentService {
  private readonly bookRoot: string
  private readonly queue: SaveQueue<SaveResult>
  private readonly journalDir: string
  private readonly snapshotsDir: string
  private readonly manifestPath: string

  constructor(opts: DocumentServiceOptions) {
    this.bookRoot = opts.bookRoot
    this.queue = opts.queue ?? new SaveQueue<SaveResult>()
    this.journalDir = join(this.bookRoot, '工作区', '.journal')
    this.snapshotsDir = join(this.bookRoot, '工作区', '.snapshots')
    this.manifestPath = join(this.bookRoot, '项目', '文档清单.jsonl')
  }

  /** 保存文档（W0-1 §5.2）。docId 稳定 ID，relPath 书仓库相对路径。 */
  save(docId: string, relPath: string, input: SaveDocumentInput): Promise<SaveOutcome> {
    // 预校验（入队前，不依赖并发状态）
    const safe = this.resolveSafePath(relPath)
    if (!safe) {
      return Promise.resolve({ ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库', superseded: false })
    }
    if (!layoutOf(relPath).capabilities.write) {
      return Promise.resolve({
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: '该文档只读，不可保存',
        superseded: false,
      })
    }
    return this.queue
      .enqueue({ docId, run: () => this.executeSave(docId, relPath, safe, input) })
      .then((qr) => ({ ...qr.result, superseded: qr.superseded }))
  }

  /** 冻结该文档保存队列（定稿流程用，已入队的跑完）。 */
  freeze(docId: string): void {
    this.queue.freeze(docId)
  }

  /** 解冻。 */
  unfreeze(docId: string): void {
    this.queue.unfreeze(docId)
  }

  /** 启动扫 journal，报 pending 无 settled/aborted（崩溃未结算）。 */
  recover(): UnsettledReport[] {
    if (!existsSync(this.journalDir)) return []
    const out: UnsettledReport[] = []
    for (const name of readdirSync(this.journalDir)) {
      if (name.startsWith('._') || !name.endsWith('.jsonl')) continue
      const docId = name.slice(0, -'.jsonl'.length)
      const pending = findUnsettled(join(this.journalDir, name))
      if (pending.length > 0) out.push({ docId, pending })
    }
    return out
  }

  // ── 串行执行体（§5.2 步骤 4-11，队列内调用）─────────

  private executeSave(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
  ): Promise<SaveResult> {
    const journalPath = join(this.journalDir, `${docId}.jsonl`)

    // 步骤 2：revision 校验（串行内执行，保证并发一致）
    const existing = existsSync(absPath)
    const currentRev: Revision = existing ? computeRevision(absPath) : null
    if (input.expectedRevision !== currentRev) {
      const reason = existing
        ? `基线不符（期望 ${input.expectedRevision ?? 'null'}，磁盘 ${currentRev}）`
        : `期望基线 ${input.expectedRevision} 但文件不存在`
      return Promise.resolve({ ok: false, code: 'REVISION_CONFLICT', reason })
    }

    // 步骤 4：journal pending（含全文快照，防丢字）
    const opId = appendPending(journalPath, docId, currentRev, input.content)

    try {
      // 步骤 5：按策略建 snapshot（修改前版本留底）
      this.maybeSnapshot(docId, relPath, absPath, input, currentRev)
      // 步骤 6-7：atomic write + fsync + rename + fsync 父目录
      atomicWriteFile(absPath, input.content, { fsync: true })
      // 步骤 8：新 revision
      const newRev = computeRevision(absPath)
      // 步骤 9：条件性更新清单（书已有清单才更新；保存不建清单，W0-1 §4.2）
      this.maybeUpdateManifest(docId, relPath)
      // 步骤 10：journal settled
      appendSettled(journalPath, opId, newRev)
      // 步骤 11
      return Promise.resolve({ ok: true, revision: newRev })
    } catch (e) {
      // 失败：journal 标 aborted（atomicWriteFile 失败已自清 tmp，未落盘）
      try {
        appendAborted(journalPath, opId, e instanceof Error ? e.message : String(e))
      } catch {
        // journal 写失败忽略（best-effort，不影响返回）
      }
      return Promise.resolve({
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存失败：${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  /** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底。 */
  private maybeSnapshot(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
    baseRevision: Revision,
  ): void {
    let reason: string | undefined
    if (input.origin === 'restore' || input.origin === 'external-merge') {
      reason = `${input.origin} 覆盖前留底`
    } else if (existsSync(absPath) && layoutOf(relPath).role === 'chapter' && input.expectedRevision !== null) {
      reason = '定稿章修改前留底（§6）'
    }
    if (!reason) return
    // snapshot = 修改前的当前磁盘内容
    const currentContent = readFileSync(absPath, 'utf-8')
    writeSnapshot(this.snapshotsDir, docId, currentContent, {
      origin: input.origin,
      reason,
      baseRevision,
    })
  }

  /** 条件性更新清单：书已有清单 + 条目已存在 → 刷新 path；否则 no-op（保存不建清单）。 */
  private maybeUpdateManifest(docId: string, relPath: string): void {
    if (!existsSync(this.manifestPath)) return
    const m = readManifest(this.manifestPath)
    const entry = m.entries.get(docId)
    if (!entry || entry.path === relPath) return
    entry.path = relPath
    writeManifest(this.manifestPath, m)
  }

  /** 路径安全：resolve + relative 防穿越，realpath 防 symlink 越出书仓库。
   *  root 自身先 realpath（tmpdir 常是 /var→/private/var 符号链接），否则文件 realpath
   *  会与未解析的 root 不一致而误判越出。 */
  private resolveSafePath(relPath: string): string | null {
    if (!relPath || relPath.includes('\0')) return null
    let root: string
    try {
      root = realpathSync(resolve(this.bookRoot))
    } catch {
      root = resolve(this.bookRoot)
    }
    const abs = resolve(root, relPath)
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    // symlink 越出检查（目标存在时，返回 realpath 更安全）
    if (existsSync(abs)) {
      try {
        const real = realpathSync(abs)
        const realRel = relative(root, real)
        if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null
        return real
      } catch {
        return null
      }
    }
    return abs
  }

  // ── 结构性操作（W2A §7，同步实现）──────────────────

  /** 新建文档（分配 docId + 落盘 + 清单登记 + invalidate）。 */
  createDocument(input: CreateDocumentInput): Promise<CreateResult> {
    return Promise.resolve(this.doCreate(input))
  }

  private doCreate(input: CreateDocumentInput): CreateResult {
    const safe = this.resolveSafePath(input.relPath)
    if (!safe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (existsSync(safe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
    if (!layoutOf(input.relPath).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该位置只读，不可新建' }
    }
    const docId = generateDocId()
    const content = input.content ?? this.defaultContent()
    try {
      mkdirSync(dirname(safe), { recursive: true })
      atomicWriteFile(safe, content, { fsync: true })
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `新建失败：${errMsg(e)}` }
    }
    // 结构性操作触发建清单（W0-1 §4.2）：无清单则建，加 entry
    this.upsertManifestEntry(docId, input.relPath)
    invalidateTreeIndex(this.bookRoot)
    return { ok: true, docId, path: input.relPath, revision: computeRevision(safe) }
  }

  /** 移动文档到新目录（章号/文件名不变，只改卷归属）。 */
  moveDocument(input: MoveDocumentInput): Promise<MoveResult> {
    return Promise.resolve(this.doMoveOrRename(input.docId, { kind: 'move', toDir: input.toDir }))
  }

  /** 重命名文档（改文件名，目录不变）。 */
  renameDocument(input: RenameDocumentInput): Promise<MoveResult> {
    return Promise.resolve(this.doMoveOrRename(input.docId, { kind: 'rename', newName: input.newName }))
  }

  /** move/rename 共用：查清单 oldPath → 算 newPath → 能力校验 → snapshot → rename → 清单更新。 */
  private doMoveOrRename(
    docId: string,
    op: { kind: 'move'; toDir: string } | { kind: 'rename'; newName: string },
  ): MoveResult {
    const oldPath = this.lookupPathByDocId(docId)
    if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }

    const newPath =
      op.kind === 'move'
        ? `${op.toDir.replace(/\/$/, '')}/${basename(oldPath)}`
        : `${dirname(oldPath)}/${op.newName}`
    if (newPath === oldPath) return { ok: true, docId, path: newPath } // 无变化，幂等

    // 能力校验：source rename+move，target write（§7.2）
    const srcCaps = layoutOf(oldPath).capabilities
    if (!srcCaps.rename || !srcCaps.move) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可移动/重命名' }
    }
    if (!layoutOf(newPath).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
    }

    const oldSafe = this.resolveSafePath(oldPath)
    const newSafe = this.resolveSafePath(newPath)
    if (!oldSafe || !newSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(oldSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
    if (existsSync(newSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

    // snapshot 留底（移动/重命名前，W0-1 §7）
    try {
      const baseRev = computeRevision(oldSafe)
      const oldContent = readFileSync(oldSafe, 'utf-8')
      writeSnapshot(this.snapshotsDir, docId, oldContent, {
        origin: 'manual',
        reason: op.kind === 'move' ? '移动前留底' : '重命名前留底',
        baseRevision: baseRev,
      })
      mkdirSync(dirname(newSafe), { recursive: true })
      renameSync(oldSafe, newSafe)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `移动/重命名失败：${errMsg(e)}` }
    }

    // 清单 path 更新（docId 不变，只改 path）
    this.updateManifestPath(docId, newPath)
    invalidateTreeIndex(this.bookRoot)
    return { ok: true, docId, path: newPath }
  }

  /** 查清单 docId → path；无清单或未登记 → null（旧书需先建清单）。 */
  private lookupPathByDocId(docId: string): string | null {
    if (!existsSync(this.manifestPath)) return null
    return readManifest(this.manifestPath).entries.get(docId)?.path ?? null
  }

  /** 清单登记/upsert（无清单则建——结构性操作触发，W0-1 §4.2）。 */
  private upsertManifestEntry(docId: string, relPath: string): void {
    const m = existsSync(this.manifestPath) ? readManifest(this.manifestPath) : { version: 1, entries: new Map<string, ManifestEntry>() }
    upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
    mkdirSync(dirname(this.manifestPath), { recursive: true })
    writeManifest(this.manifestPath, m)
  }

  /** 清单 path 更新（move/rename 用，docId 不变）。 */
  private updateManifestPath(docId: string, newPath: string): void {
    if (!existsSync(this.manifestPath)) return
    const m = readManifest(this.manifestPath)
    const entry = m.entries.get(docId)
    if (!entry) return
    entry.path = newPath
    writeManifest(this.manifestPath, m)
  }

  /** 新建文档的默认内容（最小 frontmatter；具体字段由作者编辑或 batch 流程填）。 */
  private defaultContent(): string {
    return '---\n---\n\n'
  }

  /** 软删文档（移 .trash + 清单 removeEntry + trash manifest 记录 + snapshot + invalidate）。 */
  trashDocument(input: { docId: string }): Promise<TrashResult> {
    return Promise.resolve(this.doTrash(input.docId))
  }

  private doTrash(docId: string): TrashResult {
    const oldPath = this.lookupPathByDocId(docId)
    if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    if (!layoutOf(oldPath).capabilities.trash) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可删除（系统文档）' }
    }
    const oldSafe = this.resolveSafePath(oldPath)
    if (!oldSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(oldSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }

    const trashedRel = `工作区/.trash/${docId}-${basename(oldPath)}`
    try {
      // snapshot 留底（删除前，W0-1 §7）
      const baseRev = computeRevision(oldSafe)
      const content = readFileSync(oldSafe, 'utf-8')
      writeSnapshot(this.snapshotsDir, docId, content, {
        origin: 'manual',
        reason: '删除前留底',
        baseRevision: baseRev,
      })
      // 移到 工作区/.trash/<docId>-<basename>
      const trashAbs = this.resolveSafePath(trashedRel)
      if (!trashAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
      mkdirSync(dirname(trashAbs), { recursive: true })
      renameSync(oldSafe, trashAbs)
      // trash manifest 记录
      appendTrashEntry(this.bookRoot, {
        id: docId,
        originalPath: oldPath,
        trashedPath: trashedRel,
        trashedAt: new Date().toISOString(),
        role: layoutOf(oldPath).role,
      })
      // 清单 removeEntry
      if (existsSync(this.manifestPath)) {
        const m = readManifest(this.manifestPath)
        m.entries.delete(docId)
        writeManifest(this.manifestPath, m)
      }
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `删除失败：${errMsg(e)}` }
    }
    invalidateTreeIndex(this.bookRoot)
    return { ok: true, docId, trashedPath: trashedRel }
  }
}

/** 错误信息提取（避免重复 try/catch 样板）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
