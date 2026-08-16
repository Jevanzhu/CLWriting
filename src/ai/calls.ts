/**
 * 每章 AI 调用预算闸 + 任务维度计量（T5 泛化）。
 *
 * 记账存储在书库 .cache/ai-calls.json；超限阻断自动写章循环烧钱（Q2 甲）。
 * 无目录锁（当前无并行生成场景——文档 §八「不做的事」）；损坏时保守阻断。
 *
 * 数据结构（T5 泛化后）：
 *   chapter 块 — 预算闸专用，换章重置（仅 self-heal 记，通过 runTask chapter 参数）
 *   tasks 块   — 按任务类型累计、不重置（runTask 自动记账，7/7 端点覆盖）
 *
 * 与旧版差异：去掉目录锁 / limit_override / stale lock 检测（YAGNI）。
 * 旧格式（flat { chapter, used, ... }）读到即一次性迁移。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import type { BookConfig } from '../format/types.js'
import type { TokenUsage } from './provider/types.js'

/** chapter 块（预算闸专用） */
interface ChapterUsage {
  num: number
  used: number
  inputTokens: number
  outputTokens: number
  /** D4：cache 记账（可选——旧记录无此字段按 0；端点不下发则不累计） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** task 块（全端点覆盖） */
interface TaskUsage {
  used: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 磁盘记录格式 */
interface CallRecord {
  chapter: ChapterUsage
  tasks: Record<string, TaskUsage>
}

const FILE = 'ai-calls.json'

function budgetPath(bookRoot: string): string {
  return join(bookRoot, '.cache', FILE)
}

/**
 * 读记录。
 * - 文件缺失 → { rec: null, corrupt: false }（新书，正常）
 * - JSON 损坏 / 形状不对 → { rec: null, corrupt: true }（V-P2-10：预算闸据此保守阻断，
 *   与头注释承诺一致——此前损坏被当「无记录」静默放行归零，恰是自动写章烧钱最不该静默的点）
 * - 旧格式（flat { chapter: number, used: number, ... }）自动迁移。
 */
function readRecord(bookRoot: string): { rec: CallRecord | null; corrupt: boolean } {
  const fp = budgetPath(bookRoot)
  if (!existsSync(fp)) return { rec: null, corrupt: false }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>
    // 旧格式检测：raw.chapter 是 number（而非 object）→ 迁移写回
    if (typeof raw['chapter'] === 'number') {
      const migrated = migrateOldFormat(raw as unknown as OldFormat)
      writeRecord(bookRoot, migrated)
      return { rec: migrated, corrupt: false }
    }
    // 新格式
    const chapter = raw['chapter'] as ChapterUsage | undefined
    if (!chapter || typeof chapter.num !== 'number' || typeof chapter.used !== 'number') {
      return { rec: null, corrupt: true }
    }
    // D4：cache 记账字段可选——存在则必须是数字（与 X-P3a 同口径，坏条目按损坏处理）
    const cacheNum = (v: unknown): number | undefined =>
      v === undefined ? undefined : typeof v === 'number' ? v : NaN
    // X-P3a：tasks 逐条校验形状——盲 cast 遇坏条目（used 非数字）会让后续
    // 累加变 NaN 静默烂账，且绕过「损坏保守阻断」承诺；坏条目按损坏处理
    const tasks: Record<string, TaskUsage> = {}
    if (typeof raw['tasks'] === 'object' && raw['tasks'] !== null) {
      for (const [k, v] of Object.entries(raw['tasks'] as Record<string, unknown>)) {
        const t = v as Partial<TaskUsage> | null
        if (!t || typeof t.used !== 'number' || typeof t.inputTokens !== 'number' || typeof t.outputTokens !== 'number') {
          return { rec: null, corrupt: true }
        }
        const cr = cacheNum(t.cacheReadTokens)
        const cw = cacheNum(t.cacheWriteTokens)
        if (Number.isNaN(cr) || Number.isNaN(cw)) return { rec: null, corrupt: true }
        tasks[k] = {
          used: t.used,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          ...(cr !== undefined ? { cacheReadTokens: cr } : {}),
          ...(cw !== undefined ? { cacheWriteTokens: cw } : {}),
        }
      }
    }
    const chapterCr = cacheNum(chapter.cacheReadTokens)
    const chapterCw = cacheNum(chapter.cacheWriteTokens)
    if (Number.isNaN(chapterCr) || Number.isNaN(chapterCw)) return { rec: null, corrupt: true }
    return {
      rec: {
        chapter: {
          num: chapter.num,
          used: chapter.used,
          inputTokens: typeof chapter.inputTokens === 'number' ? chapter.inputTokens : 0,
          outputTokens: typeof chapter.outputTokens === 'number' ? chapter.outputTokens : 0,
          ...(chapterCr !== undefined ? { cacheReadTokens: chapterCr } : {}),
          ...(chapterCw !== undefined ? { cacheWriteTokens: chapterCw } : {}),
        },
        tasks,
      },
      corrupt: false,
    }
  } catch {
    return { rec: null, corrupt: true }
  }
}

/** 旧格式（flat record） */
interface OldFormat {
  chapter: number
  used: number
  inputTokens?: number
  outputTokens?: number
}

/** 旧格式 → 新格式迁移 */
function migrateOldFormat(old: OldFormat): CallRecord {
  return {
    chapter: {
      num: old.chapter,
      used: old.used,
      inputTokens: old.inputTokens ?? 0,
      outputTokens: old.outputTokens ?? 0,
    },
    tasks: {},
  }
}

/** 原子写记录（atomicWriteFile + fsync；mode 0600 随临时文件创建即生效——
 *  CC-P2-3：此前先默认权限写再补 chmodSync，既有短暂全局可读窗口，且裸调用无防护、
 *  成功路径同步抛错可反转 GEN_FAIL；mode 选项两问同解，chmodSync 删除） */
function writeRecord(bookRoot: string, rec: CallRecord): void {
  const fp = budgetPath(bookRoot)
  atomicWriteFile(fp, JSON.stringify(rec, null, 2) + '\n', { fsync: true, mode: 0o600 })
}

/** 预算判定：超限 → ok=false + 人话提示（三条出路在文档 §五）；损坏 → 保守阻断（V-P2-10） */
export function checkAiCallBudget(
  bookRoot: string,
  chapter: number,
  config: BookConfig,
): { ok: true; used: number; limit: number } | { ok: false; used: number; limit: number; reason: string } {
  const limit = config.budget.calls_per_chapter
  const { rec, corrupt } = readRecord(bookRoot)

  if (corrupt) {
    return {
      ok: false,
      used: 0,
      limit,
      reason: 'AI 调用记账文件 .cache/ai-calls.json 损坏，已保守阻断。可删除该文件重试（计数从零开始），但请先确认磁盘健康。',
    }
  }
  if (!rec || rec.chapter.num !== chapter) {
    // 无记录或已换章 → 计数从零开始
    return { ok: true, used: 0, limit }
  }
  if (rec.chapter.used >= limit) {
    return {
      ok: false,
      used: rec.chapter.used,
      limit,
      reason: `本章已调用 ${rec.chapter.used} 次（上限 ${limit}）。可临时提高 book.yaml 的 budget.calls_per_chapter，或降低重写次数`,
    }
  }
  return { ok: true, used: rec.chapter.used, limit }
}

/**
 * 记一次 chapter 维度 AI 调用（预算闸用；换章重置）。
 *
 * 由 runTask 在 self-heal 场景（传了 chapter 参数）自动调用。
 */
export function recordAiCall(bookRoot: string, chapter: number, usage: TokenUsage | null): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // W-P2-8：损坏不重置——静默覆盖等于绕过 checkAiCallBudget 的保守阻断；
  // 只允许人工删除文件恢复计数（阻断提示里已写明出路）
  if (corrupt) {
    console.error('[calls] .cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  if (!rec || rec.chapter.num !== chapter) {
    const fresh: CallRecord = { chapter: { num: chapter, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: rec?.tasks ?? {} }
    applyCall(fresh, usage)
    writeRecord(bookRoot, fresh)
    return
  }
  applyCall(rec, usage)
  writeRecord(bookRoot, rec)
}

/** chapter 计数 +1 并累计 tokens（原 recordAiCall 主体；D4 含 cache 字段） */
function applyCall(rec: CallRecord, usage: TokenUsage | null): void {
  rec.chapter.used += 1
  if (usage) {
    rec.chapter.inputTokens += usage.inputTokens
    rec.chapter.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      rec.chapter.cacheReadTokens = (rec.chapter.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      rec.chapter.cacheWriteTokens = (rec.chapter.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
  }
}

/**
 * 记一次 task 维度 AI 调用（全端点覆盖；不重置）。
 *
 * 由 runTask 末尾自动调用（有 bookRoot + task 时）。
 */
export function recordTaskUsage(bookRoot: string, task: string, usage: TokenUsage | null): void {
  const { rec, corrupt } = readRecord(bookRoot)
  // W-P2-8：与 recordAiCall 同口径——损坏不重置，保守阻断保持
  if (corrupt) {
    console.error('[calls] .cache/ai-calls.json 损坏，本次记账跳过（保守阻断保持）')
    return
  }
  const base: CallRecord = rec ?? { chapter: { num: 0, used: 0, inputTokens: 0, outputTokens: 0 }, tasks: {} }
  const t = base.tasks[task] ?? { used: 0, inputTokens: 0, outputTokens: 0 }
  t.used += 1
  if (usage) {
    t.inputTokens += usage.inputTokens
    t.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      t.cacheReadTokens = (t.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
  }
  base.tasks[task] = t
  writeRecord(bookRoot, base)
}
