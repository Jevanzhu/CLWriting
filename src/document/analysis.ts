/**
 * AI 分析信封（M12 块0 B0.1）—— 随书存储的 AI 生成辅助数据。
 *
 * 生成与展示解耦：AI 不可达时存量数据照常展示，仅「重新分析」置灰
 * （与三审意见落 审稿.md 同模式，符合「无开关、置灰不隐藏」）。
 *
 * 存储：项目/分析/<docId>.json，单文件按 kind 分 key（多载荷共一文档）。
 * Envelope = { 生成时间, 模型, 正文 hash, 载荷 }；正文变更（strip fm 后）
 * hash 不匹配 → 面板标「已过期」，提示可重新分析。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { safeDocId } from '../fs/safe-path.js'
import { encodeDocDirName } from './version.js'
import { createHash } from 'node:crypto'
import { bodyOf } from '../format/frontmatter.js'
import { log } from '../log/index.js'

/** 分析载荷种类（review=三审汇总 / score=体验分 / emotion=情绪曲线 / hooks=钩子密度 / style=文风总结）。 */
export type AnalysisKind = 'review' | 'score' | 'emotion' | 'hooks' | 'style'

/** 单条分析信封（payload 按 kind 各异；B0.1 统一 unknown，B4 各载荷细化类型）。 */
export interface Envelope {
  /** 生成时刻（ISO）。 */
  generatedAt: string
  /** 生成模型标识（如 driver:model）。 */
  model: string
  /** 源正文 sha256（strip fm 后；fm 改动不触发过期）。 */
  sourceHash: string
  /** 载荷（按 kind 结构不同）。 */
  payload: unknown
}

/** 分析文件候选路径（R68-3）：项目/分析/<docId>.json——写侧恒编码（legacy 冒号
 *  在 win 文件名非法）。R70-1（十八轮）：候选序**编码在前**（权威位优先）——读侧
 *  双候选时编码文件（新写落点）优先，字面旧文件仅编码不存在时兜底；此前字面在前
 *  会让迁移后的新写被字面旧信封永久遮蔽（含 verdictFp stat 恒指字面致树红点缓存
 *  永不失效）。docId 非法返回 null（safe-by-default，P1-SEC-C 契约不变）。 */
export function analysisPathCandidates(bookRoot: string, docId: string): string[] | null {
  // P1-SEC-C：safeDocId 内联，使路径安全成为函数契约（调用方无需重复校验）
  if (!safeDocId(docId)) return null
  const literal = join(bookRoot, '项目', '分析', `${docId}.json`)
  const encoded = join(bookRoot, '项目', '分析', `${encodeDocDirName(docId)}.json`)
  return literal === encoded ? [encoded] : [encoded, literal]
}

/** 分析文件路径（写侧权威位）：候选的第一个 = 编码路径。docId 非法返回 null。 */
export function analysisPath(bookRoot: string, docId: string): string | null {
  const candidates = analysisPathCandidates(bookRoot, docId)
  return candidates ? candidates[0]! : null
}

/** 已存在的分析文件（读侧定位；都不存在返回 null）。R68-3：check/run.ts 信封
 *  stat 指纹等「按现存文件取路径」的消费方用本函数，不吃单候选读写分裂。 */
export function existingAnalysisPath(bookRoot: string, docId: string): string | null {
  const candidates = analysisPathCandidates(bookRoot, docId)
  if (!candidates) return null
  for (const fp of candidates) {
    if (existsSync(fp)) return fp
  }
  return null
}

/** 全书级分析路径：项目/分析/__book__.json（按书存，不绑 docId；style 全书文风用）。 */
export function analysisBookPath(bookRoot: string): string {
  return join(bookRoot, '项目', '分析', '__book__.json')
}

/** 读某文档某 kind 的信封；无文件/无 kind/损坏 → null。docId 非法 → null。
 *  R68-3：双候选读（mac 存量字面在前、编码在后）。 */
export function readAnalysis(bookRoot: string, docId: string, kind: AnalysisKind): Envelope | null {
  const candidates = analysisPathCandidates(bookRoot, docId)
  if (!candidates) return null
  for (const fp of candidates) {
    if (!existsSync(fp)) continue
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
      const env = raw[kind]
      if (isEnvelope(env)) return env
    } catch {
      // 本候选损坏 → 继续下一候选；都不可用 → null（原语义）
    }
  }
  return null
}

/** R69-27（十七轮）：一次读盘取多个 kind 的信封（analysis-overview 等多 kind 消费方）——
 *  此前每个 kind 各调 readAnalysis = 同一 JSON 文件 existsSync+readFileSync 整读 N 遍，
 *  几百章长书的 overview 端点同步 IO 上千次、阻塞事件循环秒级。损坏候选跳过与
 *  readAnalysis 同语义；候选内任一请求 kind 命中即返回（按 kind 取用，缺失键 undefined）。 */
export function readAnalysisKinds(
  bookRoot: string,
  docId: string,
  kinds: readonly AnalysisKind[],
): Partial<Record<AnalysisKind, Envelope>> {
  const candidates = analysisPathCandidates(bookRoot, docId)
  if (!candidates) return {}
  for (const fp of candidates) {
    if (!existsSync(fp)) continue
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
      const out: Partial<Record<AnalysisKind, Envelope>> = {}
      let hit = false
      for (const k of kinds) {
        const env = raw[k]
        if (isEnvelope(env)) {
          out[k] = env
          hit = true
        }
      }
      if (hit) return out
    } catch {
      // 本候选损坏 → 继续下一候选
    }
  }
  return {}
}

/** B-15（第六十轮）：分析合并写 RMW 跨进程短锁——读 raw → merge → 整写此前无互斥，
 *  双进程并发写不同 kind 时后写者以其旧 raw 落盘，先写者的 kind 静默丢失。
 *  锁文件 `${filePath}.lock`（journal/manifest 同款基建，X-5/N7 语义）；超时降级
 *  裸写 + warn 留痕（AI 派生数据可重跑，宁裸写不阻断主流程）。 */
let ANALYSIS_LOCK_TIMEOUT_MS = 5_000

/** 测试注入钩子（生产零调用）。 */
export function __setAnalysisLockTimeoutForTest(ms: number): void {
  ANALYSIS_LOCK_TIMEOUT_MS = ms
}

function withAnalysisLock<T>(filePath: string, fn: () => T): T {
  const release = acquireCrossProcessLockWithTimeout(`${filePath}.lock`, ANALYSIS_LOCK_TIMEOUT_MS)
  if (!release) {
    log.warn('analysis', `分析锁超时，降级裸写（${filePath}）——并发合并写窗口回到无锁口径`)
    return fn()
  }
  try {
    return fn()
  } finally {
    release()
  }
}

/** 写某文档某 kind 的信封（合并写：其他 kind 保留；损坏文件重建）。docId 非法 → 跳过。
 *  R68-3：写侧恒落编码路径；合并基读双候选（mac 存量字面文件存在时其 kind 随写迁入
 *  编码文件，不被同 docId 新文件遮蔽丢失）。
 *  R70-1/R70-2（十八轮）：合并基改**双候选 overlay**（字面为底、编码文件键覆盖其上）——
 *  此前基取「首个存在候选」（字面优先）：字面与编码并存时第二次写的基不含第一次迁入
 *  编码文件的 kind，整写把先写的 kind 静默清除；且编码写成功后**锁内删字面源**——读侧
 *  候选序字面在前会让新写被字面旧信封永久遮蔽（verdictFp 取 existingAnalysisPath 的
 *  stat 恒指字面 → 树红点章级缓存永不失效）。删源后读侧权威位收敛编码路径。 */
export function writeAnalysis(
  bookRoot: string,
  docId: string,
  kind: AnalysisKind,
  envelope: Envelope,
): void {
  const fp = analysisPath(bookRoot, docId)
  if (!fp) return
  withAnalysisLock(fp, () => writeAnalysisLocked(fp, bookRoot, docId, kind, envelope))
}

/** R34D-19（三十四轮）：writeAnalysis 的异步孪生——锁等待走 acquireCrossProcessLockAsync
 *  （setTimeout 轮询，事件循环不阻塞），服务进程调用链（review/analysis 端点）专用；
 *  超时降级裸写 + warn 留痕口径与同步版逐位同源。RMW 本体抽 writeAnalysisLocked 共用
 *  （防两版漂移）。同步版保留供测试等合法同步面。 */
export async function writeAnalysisAsync(
  bookRoot: string,
  docId: string,
  kind: AnalysisKind,
  envelope: Envelope,
): Promise<void> {
  const fp = analysisPath(bookRoot, docId)
  if (!fp) return
  const release = await acquireCrossProcessLockAsync(`${fp}.lock`, ANALYSIS_LOCK_TIMEOUT_MS)
  if (!release) {
    log.warn('analysis', `分析锁超时，降级裸写（${fp}）——并发合并写窗口回到无锁口径`)
    writeAnalysisLocked(fp, bookRoot, docId, kind, envelope)
    return
  }
  try {
    writeAnalysisLocked(fp, bookRoot, docId, kind, envelope)
  } finally {
    release()
  }
}

/** R34D-19（三十四轮）：合并写 RMW 本体（锁由调用方在持）——writeAnalysis（同步壳）与
 *  writeAnalysisAsync（异步壳）共用，防两壳各持一份合并逻辑漂移。 */
function writeAnalysisLocked(fp: string, bookRoot: string, docId: string, kind: AnalysisKind, envelope: Envelope): void {
    const candidates = analysisPathCandidates(bookRoot, docId) ?? []
    // overlay 合并基：按候选序依次叠加（后读的编码文件键覆盖字面旧键）
    let raw: Record<string, unknown> = {}
    for (const cp of candidates) {
      if (cp === fp && candidates.length > 1) continue // 编码位在下方统一处理
      if (!existsSync(cp)) continue
      try {
        raw = { ...raw, ...(JSON.parse(readFileSync(cp, 'utf-8')) as Record<string, unknown>) }
      } catch {
        // 本候选损坏 → 跳过（其他候选仍可作基；全损则重建）
      }
    }
    if (existsSync(fp)) {
      try {
        raw = { ...raw, ...(JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>) }
      } catch {
        // 编码文件损坏 → 以字面基重建（丢弃损坏载荷）
      }
    }
    raw[kind] = envelope
    atomicWriteFile(fp, JSON.stringify(raw, null, 2))
    // 迁移收口：编码文件落盘成功后删字面旧源（锁内；失败不阻断——下次写重试删）
    for (const cp of candidates) {
      if (cp !== fp && existsSync(cp)) {
        try {
          rmSync(cp, { force: true })
        } catch {
          // 删源失败：读侧仍双候选可读（编码优先级靠下方读序保证），下次写重试
        }
      }
    }
}

/** 读全书级某 kind 信封（项目/分析/__book__.json；无文件/无 kind/损坏 → null）。 */
export function readBookAnalysis(bookRoot: string, kind: AnalysisKind): Envelope | null {
  const fp = analysisBookPath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    const env = raw[kind]
    return isEnvelope(env) ? env : null
  } catch {
    return null
  }
}

/** 写全书级某 kind 信封（合并写：其他 kind 保留；B-15：同款跨进程短锁）。 */
export function writeBookAnalysis(
  bookRoot: string,
  kind: AnalysisKind,
  envelope: Envelope,
): void {
  const fp = analysisBookPath(bookRoot)
  withAnalysisLock(fp, () => {
    let raw: Record<string, unknown> = {}
    if (existsSync(fp)) {
      try {
        raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
      } catch {
        /* 损坏则重建 */
      }
    }
    raw[kind] = envelope
    atomicWriteFile(fp, JSON.stringify(raw, null, 2))
  })
}

/** 算源正文 hash（strip fm 后 sha256）。调用方组装信封时用。 */
export function sourceHashOf(fullContent: string): string {
  return createHash('sha256').update(bodyOf(fullContent)).digest('hex')
}

/** 信封是否过期（源正文 hash 与当前不符）。fullContent = 文档全文（含 fm）。 */
export function isStale(envelope: Envelope, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}

/** 信封结构守卫（generatedAt/model/sourceHash 必为字符串；payload 任意）。 */
function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.generatedAt === 'string' &&
    typeof e.model === 'string' &&
    typeof e.sourceHash === 'string'
  )
}
