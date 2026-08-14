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
import { safeDocId } from '../fs/safe-path.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { computeRevision, type Revision } from './revision.js'
import { layoutOf, roleOf } from './layout.js'
import { appendAborted, appendPending, appendSettled, findUnsettled, type JournalPending } from './journal.js'
import { writeSnapshot, DEFAULT_SNAPSHOT_POLICY, type SnapshotPolicy } from './snapshot.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from './manifest.js'
import { SaveQueue } from './queue.js'
import { generateDocId, legacyId } from './stable-id.js'
import { invalidateTreeIndex, scanBookTree, type TreeNode } from './tree.js'
import { readFile as readDoc, parseFlat, stringifyFlat, splitFrontMatter, joinFrontMatter, bodyOf } from '../format/frontmatter.js'
import { appendTrashEntry, readTrashManifest } from './trash.js'
import { appendWordsDelta, todayDate } from './words-diary.js'
import { countWords } from '../format/words.js'
import { readBookConfig } from '../format/yaml.js'

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

/** 复制文档输入（E3.3）。relPath 由前端算好章号 +「副本」标题；后端复制源内容到该 path。 */
export interface CopyDocumentInput {
  /** 源文档 docId（须在清单登记）。 */
  docId: string
  /** 目标相对路径（含 .md 后缀）。 */
  relPath: string
}

/** 复制结果（结构同 CreateResult，错误码多 NOT_FOUND：源未登记或文件缺失）。 */
export type CopyResult =
  | { ok: true; docId: string; path: string; revision: `sha256:${string}` }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'WRITE_ERROR'; reason: string }

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
    this.snapshotsDir = join(this.bookRoot, '工作区', '.版本')
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

  /** docId → relPath（含 legacy 兜底：旧文件首次访问时扫盘反查并补登记清单，
   *  stable-id.ts「首次结构性操作时落盘」）。未登记且非 legacy / 无匹配 → null。 */
  resolvePath(docId: string): string | null {
    return this.lookupPathByDocId(docId)
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
    // P1-SEC-A：journal 路径含 docId，显式校验防穿越（与 version.ts/analysis.ts 对齐）
    if (!safeDocId(docId)) return Promise.resolve({ ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' })
    const journalPath = join(this.journalDir, `${docId}.jsonl`)

    // V-P2-1：结构性操作（rename/move/trash）同步执行、不排队，与入队 save 存在竞态窗口——
    // 新建档（expectedRevision=null）的排队 save 若在移动/删除后出队，会在旧路径复活
    // 已移走/已删文件（trash 场景绕过回收站）。出队时按清单核对保存目标仍是该 docId
    // 的登记路径；已删（清单除名 + 回收站在案）同样拒绝。REVISION_CONFLICT 语义 =
    // 「世界已变，请刷新重试」，前端既有冲突处理会重新同步路径。
    const registered = this.lookupPathByDocId(docId)
    if (registered !== null && registered !== relPath) {
      return Promise.resolve({
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: `文档已移动或重命名（现路径 ${registered}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
      })
    }
    if (registered === null && readTrashManifest(this.bookRoot).some((t) => t.id === docId)) {
      return Promise.resolve({
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
      })
    }

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
      // P2-BE-1：wordDelta 计算移入 try——readFileSync 失败时 journal 标 aborted（而非孤儿 pending 误报崩溃）
      // 步骤 4.5：算字数 delta（E4）——须在 atomicWrite 前读旧内容；strip fm 口径（与前端 updateWordCount 一致）
      const wordDelta =
        countWords(bodyOf(input.content)) -
        countWords(existing ? bodyOf(readFileSync(absPath, 'utf-8')) : '')

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
      // P2-BE-4：字数增量 best-effort（settled 后失败不影响保存结果——否则文件已落盘但返回 WRITE_ERROR 误报失败）
      try {
        appendWordsDelta(this.bookRoot, todayDate(), wordDelta, docId)
      } catch {
        // 磁盘满等忽略——保存已成功，字数日记丢失可接受
      }
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

  /** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底。
   *  保存前留底走节流（policy.throttleMinutes），结构性操作（改名/删除）不节流。 */
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
    // restore/external-merge 是"真要反悔"的时刻，必留；autosave 走节流
    const force = input.origin === 'restore' || input.origin === 'external-merge'
    writeSnapshot(
      this.snapshotsDir,
      docId,
      currentContent,
      { origin: input.origin, reason, baseRevision },
      { policy: this.snapshotPolicy(), force },
    )
  }

  /** 快照保留策略：book.yaml 的 snapshots 段覆盖默认值（缺省 = 默认）。 */
  private snapshotPolicy(): SnapshotPolicy {
    const cfg = readBookConfig(join(this.bookRoot, 'book.yaml'))
    const s = cfg.ok ? cfg.config.snapshots : undefined
    return {
      maxDays: s?.max_days ?? DEFAULT_SNAPSHOT_POLICY.maxDays,
      maxCount: s?.max_count ?? DEFAULT_SNAPSHOT_POLICY.maxCount,
      throttleMinutes: DEFAULT_SNAPSHOT_POLICY.throttleMinutes,
    }
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

  /** 更新章节元数据（标题/章号）。
   *  - 长篇 chapter：写 fm + 文件名同步 rename（章号4位-标题.md，docId 不变）。
   *  - 短篇 piece-body：写 fm + 文件名同步 rename（章号3位-标题.md，docId 不变）+ 章纲同名跟随。 */
  updateChapterMeta(docId: string, meta: { 标题?: string; 章号?: number }): MoveResult {
    const path = this.lookupPathByDocId(docId)
    if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    const abs = this.resolveSafePath(path)
    if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    const r = readDoc(abs)
    if (!r.ok) return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${r.error.message}` }
    const map = parseFlat(r.fmRaw)
    if (meta.标题 !== undefined) map.set('标题', meta.标题)
    // piece-body / chapter 统一写「章号」字段
    // 缓存 isPieceBody 结果（一次 readBookConfig，避免同方法内两次磁盘读）
    const isPiece = isPieceBody(path, this.bookRoot)
    if (meta.章号 !== undefined) map.set('章号', meta.章号)
    try {
      // 元数据写入走原子写（P1-6A：防 writeFileSync 半截损坏不可恢复）
      atomicWriteFile(abs, joinFrontMatter(stringifyFlat(map), r.body), { fsync: true })
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
    }
    const 标题 = String(map.get('标题') ?? '')
    invalidateTreeIndex(this.bookRoot)

    if (isPiece) {
      // 短篇：rename 文件名（章号3位-标题.md）+ 同步章纲同名文件
      const 章号 = map.get('章号')
      const numPrefix =
        typeof 章号 === 'number'
          ? `${String(章号).padStart(3, '0')}-`
          : (basename(path).match(/^(\d+-)/)?.[1] ?? '')
      const newName = `${numPrefix}${标题.replace(/[\\/]/g, '_')}.md`
      if (basename(path) !== newName) {
        const result = this.doMoveOrRename(docId, { kind: 'rename', newName })
        if (result.ok) this.syncRenamePieceList(path, newName)
        return result
      }
      return { ok: true, docId, path }
    }

    // 长篇 chapter：文件名按 章号4位-标题.md
    const 章号 = map.get('章号')
    const newName =
      typeof 章号 === 'number' ? `${String(章号).padStart(4, '0')}-${标题.replace(/[\\/]/g, '_')}.md` : basename(path)
    if (basename(path) !== newName) {
      return this.doMoveOrRename(docId, { kind: 'rename', newName })
    }
    return { ok: true, docId, path }
  }

  /** 短篇章纲同步重命名（章纲/Old.md → 章纲/New.md）：
   *  正文已 rename，章纲同名文件跟随。章纲不存在时静默跳过（不阻断正文 rename）。 */
  private syncRenamePieceList(oldBodyRel: string, newName: string): void {
    const oldListRel = `大纲/章纲/${basename(oldBodyRel)}`
    const newListRel = `大纲/章纲/${newName}`
    const oldSafe = this.resolveSafePath(oldListRel)
    const newSafe = this.resolveSafePath(newListRel)
    if (!oldSafe || !newSafe) return
    if (!existsSync(oldSafe)) return
    try {
      mkdirSync(dirname(newSafe), { recursive: true })
      renameSync(oldSafe, newSafe)
    } catch {
      // 清单同步失败不阻断正文 rename
    }
  }

  /** 更新文档 frontmatter 字段（通用，不联动文件名；卷纲/总纲用）。
   *  与 updateChapterMeta 的区别：不改文件名（卷纲/总纲文件名不按 章号-标题）。 */
  updateDocMeta(docId: string, meta: Record<string, unknown>): MoveResult {
    const path = this.lookupPathByDocId(docId)
    if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    const abs = this.resolveSafePath(path)
    if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    let raw: string
    try {
      raw = readFileSync(abs, 'utf-8')
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${errMsg(e)}` }
    }
    // 容错：裸 md 无 fm（旧书卷纲/总纲）→ 整体当 body，新建 fm
    const split = splitFrontMatter(raw)
    const map = parseFlat(split ? split.fmRaw : '')
    const body = split ? split.body : raw
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) map.set(k, v)
    }
    try {
      atomicWriteFile(abs, joinFrontMatter(stringifyFlat(map), body), { fsync: true })
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
    }
    invalidateTreeIndex(this.bookRoot)
    return { ok: true, docId, path }
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
    if (existsSync(this.manifestPath)) {
      const path = readManifest(this.manifestPath).entries.get(docId)?.path
      if (path) return path
    }
    return this.adoptLegacyDoc(docId)
  }

  /**
   * legacy 临时 ID 兜底：旧书文件无清单登记时，树用 legacyId(path) 当运行期 ID，
   * 清单里查不到 → 结构性操作一律 NOT_FOUND。此处扫盘反查同 ID 的文件并补登记
   * （stable-id.ts「首次结构性操作时落盘」）。非 legacy 前缀 / 无匹配 → null。
   */
  private adoptLegacyDoc(docId: string): string | null {
    if (!docId.startsWith('legacy:')) return null
    const hit = findByLegacyId(scanBookTree(this.bookRoot), docId)
    if (!hit) return null
    this.upsertManifestEntry(docId, hit)
    return hit
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

  /** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。 */
  copyDocument(input: CopyDocumentInput): Promise<CopyResult> {
    return Promise.resolve(this.doCopy(input))
  }

  private doCopy(input: CopyDocumentInput): CopyResult {
    const srcPath = this.lookupPathByDocId(input.docId)
    if (!srcPath) return { ok: false, code: 'NOT_FOUND', reason: `源文档 ${input.docId} 未在清单登记` }
    // 能力：源 copy + 目标 write（与 create 同步实现，靠单线程微任务不交错）
    if (!layoutOf(srcPath).capabilities.copy) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可复制' }
    }
    if (!layoutOf(input.relPath).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
    }
    const srcSafe = this.resolveSafePath(srcPath)
    const dstSafe = this.resolveSafePath(input.relPath)
    if (!srcSafe || !dstSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(srcSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
    if (existsSync(dstSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

    try {
      const content = readFileSync(srcSafe, 'utf-8')
      mkdirSync(dirname(dstSafe), { recursive: true })
      atomicWriteFile(dstSafe, content, { fsync: true })
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `复制失败：${errMsg(e)}` }
    }
    // 新 docId + 清单登记（结构性操作触发建清单，W0-1 §4.2）
    const newDocId = generateDocId()
    this.upsertManifestEntry(newDocId, input.relPath)
    invalidateTreeIndex(this.bookRoot)
    return { ok: true, docId: newDocId, path: input.relPath, revision: computeRevision(dstSafe) }
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
      // P1-S3：rename 成功后 manifest 更新改 best-effort——失败不阻断（文件已实质删除，
      // 回收站 manifest / 主清单不一致不影响数据安全，下次操作自然修复）
      try {
        appendTrashEntry(this.bookRoot, {
          id: docId,
          originalPath: oldPath,
          trashedPath: trashedRel,
          trashedAt: new Date().toISOString(),
          role: layoutOf(oldPath).role,
        })
      } catch { /* 磁盘满等：回收站 manifest 写失败不影响删除 */
      }
      try {
        if (existsSync(this.manifestPath)) {
          const m = readManifest(this.manifestPath)
          m.entries.delete(docId)
          writeManifest(this.manifestPath, m)
        }
      } catch { /* 主清单更新失败：树重建时会发现文件不存在自动清理 */
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

/** 短篇正文（写作/正文/ + 书级 kind=short）——标题编辑联动文件名 rename + 清单同步。 */
function isPieceBody(relPath: string, bookRoot: string): boolean {
  if (roleOf(relPath) !== 'chapter') return false
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  return cfg.ok ? (cfg.config.kind ?? 'long') === 'short' : false
}

/** 深度优先找 legacyId(path) === docId 的叶子，返回其 relPath；无匹配 null。 */
function findByLegacyId(nodes: TreeNode[], docId: string): string | null {
  for (const n of nodes) {
    if (!n.isDirectory && legacyId(n.path) === docId) return n.path
    if (n.children.length) {
      const hit = findByLegacyId(n.children, docId)
      if (hit) return hit
    }
  }
  return null
}
