/**
 * DocumentService —— 文档保存协议编排（W0-1 §5）。
 *
 * 统一文档写入入口：UI / AI / CLI 一律经此保存，保证并发安全 + 崩溃可恢复。
 *
 * save 编排（§5.2，每文档串行队列内执行）：
 *   预校验路径（拒 symlink/`..` 越出）+ 能力（只读文档拒写）
 *   → 入 per-docId 串行队列 → 队列内串行执行：
 *     revision 校验 → journal pending → 按策略 snapshot → atomic write+fsync
 *     → 算新 revision → 条件性更新清单 → journal settled
 *
 * 冲突 / 能力不足 / 落盘失败 → 不落盘、journal 标 aborted、返回 {ok:false,code}。
 * freeze(docId) 暂停该文档保存队列（定稿流程用，防 autosave 改文件使 confirm hash 失效）。
 * recover() 启动扫 journal，报 pending 无 settled/aborted（崩溃未结算）提示作者恢复。
 *
 * docId 是稳定 ID（队列/日志/清单 key），relPath 是落盘路径——W1 不做 docId→path 反查（W2A）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { computeRevision, type Revision } from './revision.js'
import { layoutOf } from './layout.js'
import { appendAborted, appendPending, appendSettled, findUnsettled, type JournalPending } from './journal.js'
import { writeSnapshot } from './snapshot.js'
import { readManifest, writeManifest } from './manifest.js'
import { SaveQueue } from './queue.js'

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
}
