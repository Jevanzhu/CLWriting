/**
 * 连写编排逻辑层 —— 依据 M6 #33。
 *
 * 把单章八阶段串成「无人值守连写一批」。核心设计（#33 第 1 节）：
 * - 工作区根 = 当前在写的那一章（复用 #11/#23/态 4 全部既有逻辑，零侵入）
 * - 写完一章整体搬入 待定稿/<章号-标题>/，清空工作区根，再写下一章
 * - 章号自管：只认 .auto-batch.json 的 next_chapter，不靠 detectState（防章号重复）
 * - AI 步是接缝：编排层只串联脚本步 + 搬运 + 游标，真模型产出由宿主经回调提供
 *
 * 停止四件套 + 坏章隔离在 WP4 扩展（本文件先做主体编排 + 搬运 + 批次进度）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BookConfig, ChapterMeta } from '../format/types.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { prepareMaterials } from '../process/materials.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { git } from '../git/exec.js'
import { isEditingWorkdirActive } from '../process/gui-active.js'

// ── 待定稿路径常量 ─────────────────────────────────

export const PENDING_DIR_NAME = '待定稿'
export const ISOLATED_DIR_NAME = '.isolated'
export const BATCH_FILE = '.auto-batch.json'

/** 待定稿根目录：工作区/待定稿/ */
export function pendingRoot(bookRoot: string): string {
  return join(bookRoot, '工作区', PENDING_DIR_NAME)
}

/** 批次进度文件：工作区/待定稿/.auto-batch.json */
export function batchFilePath(bookRoot: string): string {
  return join(pendingRoot(bookRoot), BATCH_FILE)
}

// ── .auto-batch.json schema（#33 第 3 节）──────────

export interface BatchPause {
  at_chapter: number
  reason: 'budget' | 'quality' | 'human' | 'system'
  detail: string
  paused_at: string
}

export interface IsolatedChapter {
  chapter: number
  reason: 'quality' | 'system'
  detail: string
}

export interface BatchProgress {
  start_chapter: number
  target_count: number
  next_chapter: number
  completed: number[]
  isolated: IsolatedChapter[]
  paused: BatchPause | null
  started_at: string
  /** 启动 batch 的宿主进程 pid（W0-2 §5.2 活跃性探活；旧批次文件缺此字段）。 */
  host_pid?: number
}

/** 读批次进度（容错：缺失/损坏返回 null，不静默重置）。 */
export function readBatchProgress(bookRoot: string): BatchProgress | null {
  const fp = batchFilePath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const obj = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<BatchProgress>
    if (
      typeof obj.start_chapter !== 'number' ||
      typeof obj.target_count !== 'number' ||
      typeof obj.next_chapter !== 'number' ||
      !Array.isArray(obj.completed)
    ) {
      return null
    }
    return {
      start_chapter: obj.start_chapter,
      target_count: obj.target_count,
      next_chapter: obj.next_chapter,
      completed: obj.completed,
      isolated: Array.isArray(obj.isolated) ? obj.isolated : [],
      paused: obj.paused ?? null,
      started_at: obj.started_at ?? new Date().toISOString(),
      host_pid: typeof obj.host_pid === 'number' ? obj.host_pid : undefined,
    }
  } catch {
    return null
  }
}

/** 写批次进度。 */
export function writeBatchProgress(bookRoot: string, progress: BatchProgress): void {
  mkdirSync(pendingRoot(bookRoot), { recursive: true })
  atomicWriteFile(batchFilePath(bookRoot), JSON.stringify(progress, null, 2))
}

// ── 搬运：工作区根产出 → 待定稿/<章>/（#33 第 4 节）──

type UnitKind = 'long' | 'short'

function unitKind(config: BookConfig): UnitKind {
  return config.kind === 'short' ? 'short' : 'long'
}

function unitWidth(kind: UnitKind): number {
  return kind === 'short' ? 3 : 4
}

/** 连写产出在工作区根的固定文件名（与单章/单篇工作区一致，复用既有命名）。 */
const WORKDIR_PRODUCT_FILES = ['细纲.md', '本章写作材料.md', '审稿.md', '账本推进.md', '清单.md']

/** 工作区根前缀的产出文件（草稿-N.md + 机器域）。 */
interface WorkDirProducts {
  /** 草稿文件名（草稿-1.md 等） */
  drafts: string[]
  /** 机器域文件（.confirm.json / .ai-calls.json） */
  machine: string[]
  /** 其他产出（机检报告/三审目录等） */
  others: string[]
}

/** 扫工作区根的连写产出（用于搬运）。 */
function scanWorkDirProducts(workDir: string): WorkDirProducts {
  const drafts: string[] = []
  const machine: string[] = []
  const others: string[] = []
  if (!existsSync(workDir)) return { drafts, machine, others }
  for (const f of readdirSync(workDir)) {
    if (f.startsWith('草稿-') || f.startsWith('._草稿-')) {
      drafts.push(f)
    } else if (f === '.confirm.json' || f === '.ai-calls.json') {
      machine.push(f)
    } else if (WORKDIR_PRODUCT_FILES.includes(f) || f === '三审' || f === '机检报告.md') {
      others.push(f)
    }
  }
  return { drafts, machine, others }
}

/** 待定稿单元目录名：长篇 4 位章号，短篇 3 位篇号（对齐 commit 口径）。 */
export function pendingUnitDirName(chapter: number, title: string, kind: UnitKind = 'long'): string {
  return `${String(chapter).padStart(unitWidth(kind), '0')}-${title}`
}

/** 待定稿章目录名：<章号4位补零>-<标题>（兼容旧调用）。 */
export function pendingChapterDirName(chapter: number, title: string): string {
  return pendingUnitDirName(chapter, title, 'long')
}

/**
 * 搬运：工作区根产出整体移入 待定稿/<章号-标题>/，清空工作区根。
 * 写完一章的固定产出 + 机器域全部搬走（逐章可追溯，#33 第 5 节）。
 */
export function moveToPending(
  workDir: string,
  bookRoot: string,
  chapter: number,
  title: string,
  kind: UnitKind = 'long',
): string {
  const dirName = pendingUnitDirName(chapter, title, kind)
  const dest = join(pendingRoot(bookRoot), dirName)
  mkdirSync(dest, { recursive: true })

  const products = scanWorkDirProducts(workDir)
  const moveFile = (name: string) => {
    const src = join(workDir, name)
    if (existsSync(src)) {
      const target = join(dest, name)
      renameSync(src, target)
    }
  }

  for (const f of [...products.drafts, ...products.machine, ...products.others]) {
    moveFile(f)
  }

  return dest
}

// ── 连写编排主循环（#33 第 4 节）────────────────────

/**
 * 单章产出接口（AI 步接缝）。
 * 编排层在每个章号调用 produce，宿主（或测试桩）填入本章的细纲 + 正文 + 章元数据。
 * 脚本步（确认/机检/三审打包）由编排层串联；真模型调用在 produce 内（宿主侧）。
 */
export interface ChapterProduction {
  /** 章标题（用于待定稿目录命名） */
  title: string
  /** 细纲文本（写入工作区根 细纲.md） */
  outline: string
  /** 正文（写入工作区根 草稿-1.md，含 front matter） */
  body: string
  /** 章元数据（front matter 解析后） */
  chapter: ChapterMeta
}

/**
 * 备料工具（M7 #37 R1 接缝接入）。
 * 编排层把它注入 produce 回调，宿主在 produce 内 `await tools.prepareMaterials(leadIds)` 拿含
 * RAG 召回的备料（未配 RAG 时行为逐字节不变；端点挂/未配 key 自动降级回落精准读取）。
 *
 * 这样备料时机仍归宿主控制（#33 原则：编排层只管搬运+游标，脚本步在 produce 内串联），
 * 编排层不主动调 prepare——尊重 M2 既有的「prepare 是宿主在 produce 内组织」的现状。
 */
export interface ProduceTools {
  /** 备料（近况+账本+文风+RAG 召回），返回写作材料文本 */
  prepareMaterials: (chapterLeadIds: string[], query?: string, sampleScene?: string) => Promise<{
    text: string
    /** 是否触发 RAG 召回（未配/降级 → false） */
    ragUsed: boolean
    /** 召回命中数 */
    ragHitCount: number
  }>
}

/** 停止触发（四件套，#34 第 3 节）。宿主返回此值 → 编排层记 paused + 按类处置。 */
export interface StopTrigger {
  /** 触发类型：budget 预算 / quality 质量 / human 需人 / system 系统 */
  reason: BatchPause['reason']
  /** 人话详情（记入 paused.detail） */
  detail: string
  /** ② 质量 / ④ 系统 触发时，本章半截产出是否需隔离（坏章不出批次） */
  isolate?: boolean
}

/**
 * 单章产出回调：编排层传章号 + bookRoot + config + 备料工具，宿主返回本章产出或停止触发。
 * - 返回 ChapterProduction：本章成功产出 → 搬入待定稿
 * - 返回 StopTrigger：触发停止四件套 → 编排层记 paused + 按类处置（②④隔离）
 *
 * **async**（M7 #37 R1 接缝）：宿主可在 produce 内 await prepareMaterials（含 RAG 召回，
 * 联网 embed 必须异步）。编排层 await 此回调。
 */
export type ProduceChapter = (input: {
  chapter: number
  bookRoot: string
  workDir: string
  config: BookConfig
  /** 备料工具（含 RAG 召回接缝）；宿主在 produce 内按需 await 调用 */
  tools: ProduceTools
}) => Promise<ChapterProduction | StopTrigger | null>

export interface AutoBatchOptions {
  bookRoot: string
  /** 连写章数（覆盖 batch_size） */
  targetCount: number
  /** 起始章号（默认从下一章算；resume 时读批次进度） */
  startChapter?: number
  /** 单章产出回调（AI 步接缝） */
  produce: ProduceChapter
  /**
   * 备料工具工厂（M7 #37 R1 接缝接入）。
   * 编排层每章为 produce 注入一个 tools 实例（绑定本章 config+bookRoot+workDir）。
   * 默认用 process/materials.ts 的 prepareMaterials（惰性开 db）；测试可注入桩。
   */
  toolsFactory?: (ctx: { config: BookConfig; bookRoot: string; workDir: string }) => ProduceTools
  /** resume 模式：读既有批次进度续跑（不重置） */
  resume?: boolean
}

export type AutoBatchResult =
  | { ok: true; progress: BatchProgress; produced: number[] }
  | { ok: false; reason: string; progress?: BatchProgress }

/**
 * 连写编排主循环（#33 第 4 节）。
 *
 * 循环（next_chapter < start + target 且未触发停止）：
 *   1. 工作区根写第 next_chapter 章（await produce 回调产出细纲+正文）
 *   2. 搬运：工作区根产出移入 待定稿/<next_chapter>-<标题>/
 *   3. 清空工作区根；progress.completed += next_chapter；next_chapter += 1
 *
 * 章号自管：只认 progress.next_chapter，不靠 detectState。
 * 自动确认/机检/调用闸在 produce 内由宿主串联（编排层只管搬运 + 游标）。
 *
 * **async**（M7 #37 R1）：produce 是 async（宿主可在内 await prepareMaterials 含 RAG 召回）。
 */
export async function doAutoBatch(opts: AutoBatchOptions): Promise<AutoBatchResult> {
  const { bookRoot, targetCount, produce } = opts
  const workDir = join(bookRoot, '工作区')
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const kind = unitKind(config)

  // 卷纲硬闸只属于长篇；短篇集无卷纲。
  if (kind === 'long') {
    const volumeOutlineDir = join(bookRoot, '大纲', '卷纲')
    if (!existsSync(volumeOutlineDir) || readdirSync(volumeOutlineDir).length === 0) {
      return { ok: false, reason: '当前卷纲是空的，连写前先写卷纲（大纲/卷纲/）。' }
    }
  }

  // 初始化或续读批次进度
  let progress: BatchProgress
  if (opts.resume) {
    const existing = readBatchProgress(bookRoot)
    if (!existing) {
      return { ok: false, reason: '没有未完批次可恢复（工作区/待定稿/.auto-batch.json 不存在或损坏）。' }
    }
    if (existing.paused) {
      // 清暂停标记，从 next_chapter 续写（触发章由调用方先处理）
      existing.paused = null
    }
    progress = existing
  } else {
    // 新批次：已有未完批次 → 拒绝静默覆盖（无论是否 paused，未完就要 resume 或回滚）
    const existing = readBatchProgress(bookRoot)
    if (existing && existing.completed.length < existing.target_count) {
      return { ok: false, reason: '已有未完批次，先用 clwriting auto --resume 续跑，或整批回滚后再开新批。', progress: existing }
    }
    const startChapter = opts.startChapter ?? detectNextChapter(bookRoot)
    progress = {
      start_chapter: startChapter,
      target_count: targetCount,
      next_chapter: startChapter,
      completed: [],
      isolated: [],
      paused: null,
      started_at: new Date().toISOString(),
      host_pid: process.pid,
    }
    writeBatchProgress(bookRoot, progress)
  }

  // 连写主循环
  const produced: number[] = []
  const endChapter = progress.start_chapter + progress.target_count
  while (progress.next_chapter < endChapter && !progress.paused) {
    const chapterNum = progress.next_chapter

    // 工作区编辑锁（W0-2 §5 第一层）：编辑器正在编辑工作区草稿/细纲 → 暂停连写（不跳章）
    if (isEditingWorkdirActive(bookRoot)) {
      progress.paused = {
        at_chapter: chapterNum,
        reason: 'human',
        detail: 'GUI 正在编辑工作区文档，连写暂停（auto --resume 续跑）',
        paused_at: new Date().toISOString(),
      }
      writeBatchProgress(bookRoot, progress)
      break
    }

    // ④ 系统：每章前 git 健康检查（#16，搬运前校验，污染不出批次）
    if (!checkGitHealthy(bookRoot)) {
      progress.paused = {
        at_chapter: chapterNum,
        reason: 'system',
        detail: 'git 健康检查失败（半提交/冲突/锁/网盘副本），先 clwriting health 处理',
        paused_at: new Date().toISOString(),
      }
      writeBatchProgress(bookRoot, progress)
      break
    }

    // 备料工具注入（M7 #37 R1 接缝）：宿主在 produce 内按需 await tools.prepareMaterials
    // 才真正开 db + 重建缓存 + 召回。惰性设计——桩 produce 不调 tools 时零开销、不碰 db
    // （M6 原 doAutoBatch 根本不碰 db，这保证未用备料的连写行为逐字节不变）。
    const tools = opts.toolsFactory
      ? opts.toolsFactory({ config, bookRoot, workDir })
      : makeDefaultTools(config, bookRoot, workDir)

    // AI 步接缝：宿主产出本章（或返回停止触发）—— async（宿主可内 await prepareMaterials）
    const result = await produce({ chapter: chapterNum, bookRoot, workDir, config, tools })

    // null → 需人（兼容旧接口，宿主未明确原因）
    if (!result) {
      progress.paused = {
        at_chapter: chapterNum,
        reason: 'human',
        detail: '宿主未产出本章（需人工介入）',
        paused_at: new Date().toISOString(),
      }
      writeBatchProgress(bookRoot, progress)
      break
    }

    // StopTrigger → 停止四件套处置（#34 第 3 节）
    if ('reason' in result && typeof result.reason === 'string') {
      const trigger = result as StopTrigger
      // ②④ 隔离坏章（工作区根半截产出移到 .isolated/，不出批次）
      if (trigger.isolate) {
        isolateCurrentChapter(workDir, bookRoot, chapterNum, trigger, kind)
        progress.isolated.push({ chapter: chapterNum, reason: trigger.reason === 'human' ? 'quality' : (trigger.reason as 'quality' | 'system'), detail: trigger.detail })
        // 隔离章不回填、不复用，#34 第 4 节。
        progress.next_chapter = chapterNum + 1
      }
      progress.paused = {
        at_chapter: chapterNum,
        reason: trigger.reason,
        detail: trigger.detail,
        paused_at: new Date().toISOString(),
      }
      writeBatchProgress(bookRoot, progress)
      break
    }

    // ChapterProduction → 成功产出，搬运入待定稿
    const production = result as ChapterProduction
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, '细纲.md'), production.outline, 'utf-8')
    writeFileSync(join(workDir, '草稿-1.md'), production.body, 'utf-8')

    moveToPending(workDir, bookRoot, chapterNum, production.title, kind)

    progress.completed.push(chapterNum)
    progress.next_chapter = chapterNum + 1
    produced.push(chapterNum)
    writeBatchProgress(bookRoot, progress)
  }

  return { ok: true, progress, produced }
}

/**
 * 默认备料工具工厂（M7 #37 R1 接缝）。
 * 惰性：宿主真调 prepareMaterials 时才开 db + 重建缓存 + 召回。
 * 未配 RAG → 行为逐字节不变；端点挂/未配 key → 自动降级回落精准读取。
 */
function makeDefaultTools(
  config: BookConfig,
  bookRoot: string,
  workDir: string,
): ProduceTools {
  return {
    prepareMaterials: async (chapterLeadIds: string[], query?: string, sampleScene?: string) => {
      // 惰性开 db：宿主不调本方法就零开销（M6 原 doAutoBatch 不碰 db，此处保持）
      const cachePath = join(bookRoot, '.cache', 'index.db')
      rebuildCache(bookRoot, cachePath)
      const db = new DatabaseSync(cachePath)
      try {
        const r = await prepareMaterials(db, config, {
          bookRoot,
          workDir,
          chapterLeadIds,
          ...(query ? { query } : {}),
          ...(sampleScene ? { sampleScene } : {}),
        })
        return { text: r.text, ragUsed: r.ragUsed, ragHitCount: r.ragHitCount }
      } finally {
        db.close()
      }
    },
  }
}

/** 备料前重建缓存（让近况/账本反映已定稿章）。失败不阻断连写。 */
function rebuildCache(bookRoot: string, cachePath: string): void {
  try {
    rebuild(bookRoot, cachePath)
  } catch {
    // 缓存重建失败：备料照常（prepare 内 assembleStatus 会基于现有 db 给出近况）
  }
}

/** ④ 系统：git 健康检查（简版，调 git status 判是否有半提交/冲突）。 */
function checkGitHealthy(bookRoot: string): boolean {
  // git 健康的最低判据：能跑 status 且无 MERGE_HEAD/index.lock
  if (!git(['status', '--porcelain'], bookRoot).ok) return false
  if (existsSync(join(bookRoot, '.git', 'MERGE_HEAD'))) return false
  if (existsSync(join(bookRoot, '.git', 'index.lock'))) return false
  return true
}

/** ②④ 坏章隔离：工作区根半截产出移到 待定稿/.isolated/<章>/，不进 completed（#34 第 4 节）。 */
function isolateCurrentChapter(
  workDir: string,
  bookRoot: string,
  chapter: number,
  trigger: StopTrigger,
  kind: UnitKind,
): void {
  const isoDir = join(pendingRoot(bookRoot), ISOLATED_DIR_NAME, String(chapter).padStart(unitWidth(kind), '0'))
  mkdirSync(isoDir, { recursive: true })
  // 把工作区根现有的半截产出搬过去（若 produce 写了部分文件）
  if (existsSync(workDir)) {
    for (const f of readdirSync(workDir)) {
      if (f === PENDING_DIR_NAME) continue
      try {
        renameSync(join(workDir, f), join(isoDir, f))
      } catch {
        // 个别文件搬不动忽略（已尽力隔离）
      }
    }
  }
  // 记隔离原因留痕
  writeFileSync(join(isoDir, '.isolation.json'), JSON.stringify({ chapter, reason: trigger.reason, detail: trigger.detail, at: new Date().toISOString() }, null, 2), 'utf-8')
}

/**
 * 算下一章号（新批次起始章）。
 * 从定稿目录扫描最大章号推算（文件名是真源；不受 git log 条数影响）。
 * 不依赖 detectState（连写时 currentChapter 不含待定稿）。
 */
function detectNextChapter(bookRoot: string): number {
  const nums: number[] = []
  collectUnitNumbers(join(bookRoot, '定稿', '正文'), nums)
  collectUnitNumbers(join(bookRoot, '篇'), nums)
  if (nums.length > 0) return Math.max(...nums) + 1

  const log = git(['log', '--oneline'], bookRoot)
  if (log.ok) {
    // 兼容长短轨前缀（M8 #26）：long → ch:NNNN，short → pc:NNN
    const matches = [...log.stdout.matchAll(/(?:ch|pc):(\d+)/g)]
    if (matches.length > 0) {
      const max = Math.max(...matches.map((m) => Number(m[1])))
      return max + 1
    }
  }
  return 1
}

function collectUnitNumbers(dir: string, out: number[]): void {
  if (!existsSync(dir)) return
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('._')) continue
      const m = name.match(/^(\d+)-/)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isSafeInteger(n) && n > 0) out.push(n)
    }
  } catch {
    // 目录不可读时回退 git log
  }
}

// ── 整批回滚（#35 第 4 节）─────────────────────────

/**
 * 整批回滚：清待定稿暂存（未定稿，不涉 git）。
 * 删 待定稿/ 各章目录 + .auto-batch.json；不动 定稿/ 与 git 历史。
 */
export function clearPendingBatch(bookRoot: string): { ok: true; cleared: number } | { ok: false; reason: string } {
  const root = pendingRoot(bookRoot)
  if (!existsSync(root)) return { ok: true, cleared: 0 }
  let count = 0
  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue // 跳 .isolated/ 等隐藏目录,不计入清理章数
      const fp = join(root, entry)
      if (statSync(fp).isDirectory()) count++
    }
  } catch {
    // 读取失败忽略
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    return { ok: false, reason: '清待定稿失败（权限或路径问题）' }
  }
  return { ok: true, cleared: count }
}
