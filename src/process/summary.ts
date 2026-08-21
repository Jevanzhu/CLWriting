/**
 * 章摘要生成器（迭代方向 C1 / 批 2，P7-①：定稿即生成 + prepare 按需自愈）。
 *
 * 三层摘要金字塔（前章原文结尾 → 章摘要 → 卷摘要）此前只有消费方（prepare rank 1/3）
 * 与预算键（summary_chapter_max），唯独没有写这些文件的代码——纯靠作者手写约定。
 * 本模块补上生成器：
 *
 * - 产物：定稿/摘要/章摘要/<章号>.md（**纯数字文件名**——rebuild 的 scanSummaries
 *   按 `Number(stem)` 归集，设计方案原稿的 `<章号>-<标题>.md` 会被扫描器静默跳过，
 *   命名以扫描器现实为准）；front matter {chapter, generatedAt, model, sourceHash}。
 * - sourceHash 绑定定稿正文（computeRevision 同源）：正文后改 → 摘要视为过期，
 *   下次定稿/自愈重新生成。文件即真相：作者手改摘要正文自由，改 fm 才影响过期判定。
 * - 两个挂点：
 *   ① 定稿即生成（api/documents.ts finalize 后 best-effort fire-and-forget——失败
 *      log.warn 不阻断定稿，留待自愈兜底；不占 calls_per_chapter 章预算）；
 *   ② 自愈补漏（prepareMaterials 备料前发现近章摘要缺失/过期 → 现场补生成，
 *      计入当前写作章的 calls_per_chapter 预算——既有预算闸口径）。
 * - 开关：book.yaml summary.auto: false 整体关闭（回到手写约定现状）。
 * - 红线（设计总则 3）：摘要注入备料的「模型可见 ⟺ 已记录」经 promptMeta.files 登记
 *   （prepare 返回 injectedSummaryFiles → self-heal runSpec promptFiles → llm/call 事件）。
 */
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { chapterNamePrefixes, parseChapterFileName } from '../format/chapters.js'
import { readDraft } from '../format/draft.js'
import { computeRevision } from '../document/revision.js'
import { readManifest } from '../document/manifest.js'
import { rebuild } from '../cache/rebuild.js'
import { runSpec } from '../ai/tasks/spec.js'
import { registerBackgroundTask } from '../ai/orchestrate/background.js'
import { SUMMARY_CHAPTER_SPEC, SUMMARY_VOLUME_SPEC } from '../ai/tasks/specs.js'
import { applyGlobalDefaults } from '../format/global-defaults.js'
import { readBookConfig } from '../format/yaml.js'
import type { BookConfig } from '../format/types.js'
import { log } from '../log/index.js'
import { atomicWriteFile } from '../fs/atomic.js'

/** 章摘要目录（相对书根） */
export const CHAPTER_SUMMARY_DIR = join('定稿', '摘要', '章摘要')

/** 摘要文件路径（纯数字 stem——scanSummaries 的 Number() 归集口径） */
export function chapterSummaryPath(bookRoot: string, chapter: number): string {
  return join(bookRoot, CHAPTER_SUMMARY_DIR, `${chapter}.md`)
}

/** 摘要相对书根路径（promptMeta.files 登记用） */
export function chapterSummaryRelPath(chapter: number): string {
  return join(CHAPTER_SUMMARY_DIR, `${chapter}.md`)
}

export type SummaryState = 'fresh' | 'stale' | 'missing'

/**
 * 章摘要状态：文件缺失 → missing；fm.sourceHash ≠ 当前正文指纹 → stale（正文后改）；
 * 相等 → fresh。手写摘要（无 fm.sourceHash）按 fresh 处理——作者手写优先于程序重生成，
 * 不因缺元数据被程序覆盖（文件即真相）。
 */
export function chapterSummaryState(bookRoot: string, chapter: number, bodyAbsPath: string): SummaryState {
  const fp = chapterSummaryPath(bookRoot, chapter)
  if (!existsSync(fp)) return 'missing'
  const raw = readFileSync(fp, 'utf8')
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!m) return 'fresh' // 手写摘要（无 fm）：作者优先
  const hashMatch = /^sourceHash:\s*(\S+)/m.exec(m[1]!)
  if (!hashMatch) return 'fresh' // 有 fm 无指纹：同样按作者产物对待
  return hashMatch[1] === computeRevision(bodyAbsPath) ? 'fresh' : 'stale'
}

/** 解析章摘要正文（剥 fm——prepare 注入用内容的同源读取） */
export function readChapterSummaryBody(bookRoot: string, chapter: number): string | null {
  const fp = chapterSummaryPath(bookRoot, chapter)
  if (!existsSync(fp)) return null
  const raw = readFileSync(fp, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  return (m ? raw.slice(m[0].length) : raw).trim()
}

/** 在 写作/正文/（含卷子目录）按章号找正文文件；找不到 → null */
export function findChapterFile(bookRoot: string, chapter: number): string | null {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  const prefixes = chapterNamePrefixes(chapter)
  const walk = (dir: string): string | null => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('._')) continue
        const fp = join(dir, e.name)
        if (e.isDirectory()) {
          const found = walk(fp)
          if (found) return found
        } else if (e.isFile() && e.name.endsWith('.md') && prefixes.some((p) => e.name.startsWith(p))) {
          return fp
        }
      }
    } catch {
      /* 不可读目录跳过 */
    }
    return null
  }
  return walk(bodyDir)
}

export interface GenerateChapterSummaryOpts {
  bookRoot: string
  /** APP 数据目录（provider/tier 解析 + 事件记账） */
  userDataPath: string | null
  /** 生效配置（预算 summary_chapter_max；调用方过 applyGlobalDefaults） */
  config: BookConfig
  chapter: number
  /** 正文绝对路径（findChapterFile 的结果） */
  bodyAbsPath: string
  /** 计入 calls_per_chapter 章预算的章号（自愈路径传当前写作章；定稿钩子不传=不占预算） */
  budgetChapter?: number
}

export type GenerateSummaryResult =
  | { ok: true; path: string; skipped: boolean }
  | { ok: false; error: string }

/** 同章在途去重：批量定稿并发触发 / 自愈与定稿钩子同时命中时不重复调用 */
const inFlight = new Set<string>()

/**
 * 生成（或按 sourceHash 过期重生成）一章摘要。fresh → skipped 不调 AI。
 * 产出硬约束：三行结构由 system prompt 约定；字数上限 prompt 声明 + 落盘前硬截断
 * （确定性上限，不信任模型自觉）。
 */
export async function generateChapterSummary(opts: GenerateChapterSummaryOpts): Promise<GenerateSummaryResult> {
  const { bookRoot, chapter, bodyAbsPath } = opts
  const state = chapterSummaryState(bookRoot, chapter, bodyAbsPath)
  if (state === 'fresh') return { ok: true, path: chapterSummaryPath(bookRoot, chapter), skipped: true }

  const key = `${bookRoot}#${chapter}`
  if (inFlight.has(key)) return { ok: false, error: `第 ${chapter} 章摘要生成已在途` }
  inFlight.add(key)
  try {
    const budget = opts.config.budget.summary_chapter_max ?? 200
    const draft = readDraft(bodyAbsPath)
    if (!draft.ok) return { ok: false, error: `读正文失败：${draft.reason}` }
    // 第五轮：指纹在读取时点取——AI 生成窗口（数十秒）内正文若被再改并再次定稿（H2），
    // 写盘时才算会把 H2 指纹绑给 H1 正文的摘要：过期判定从此恒 fresh，自愈与定稿
    // 钩子都被挡住，过期摘要长期喂后续章节的「近章结尾」材料。取读取时点的 H1，
    // H2 到来后过期判定正常触发重生成。
    const sourceHash = computeRevision(bodyAbsPath)
    const userPrompt = [
      `请为第 ${chapter} 章写章摘要（三行：情节推进 / 账本变动 / 章尾钩子，总长 ≤ ${budget} 字）。`,
      '',
      '## 正文',
      draft.body,
    ].join('\n')
    const out = await runSpec(SUMMARY_CHAPTER_SPEC, {
      userDataPath: opts.userDataPath,
      userPrompt,
      bookRoot,
      ...(opts.budgetChapter !== undefined ? { chapter: opts.budgetChapter } : {}),
      promptFiles: [chapterSummaryRelPath(chapter)],
    })
    if (!out.ok) return { ok: false, error: out.error }

    // 硬截断到预算（确定性上限；模型超长不信任）
    let text = out.data.text.trim()
    if (text.length > budget) text = text.slice(0, budget) + '…'
    if (text.length === 0) return { ok: false, error: 'AI 产出为空' }

    const fp = chapterSummaryPath(bookRoot, chapter)
    mkdirSync(join(bookRoot, CHAPTER_SUMMARY_DIR), { recursive: true })
    const fm = [
      '---',
      `chapter: ${chapter}`,
      `generatedAt: ${new Date().toISOString()}`,
      // 低级项（第六轮）：占位符 'summary-chapter' 换成实际模型 id（TaskOk.model 透出；
      // mock 快路无模型 → 'unknown'），留痕可追溯到生成源
      `model: ${out.model ?? 'unknown'}`,
      `sourceHash: ${sourceHash}`,
      '---',
      '',
    ].join('\n')
    atomicWriteFile(fp, fm + text + '\n')
    return { ok: true, path: fp, skipped: false }
  } finally {
    inFlight.delete(key)
  }
}

/** 读生效配置（book.yaml + 全局托底）——两个挂点共用的入口口径 */
export function effectiveConfig(bookRoot: string, userDataPath: string | null): BookConfig {
  return applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, userDataPath)
}

/** 摘要自动生成开关（summary.auto 缺省 true） */
export function summaryAutoEnabled(config: BookConfig): boolean {
  return config.summary?.auto !== false
}

/**
 * 挂点一（定稿即生成，P7-①）：finalize 管线成功后由 API 层调用（依赖方向：document/
 * 禁止 import AI 层，钩子只能挂服务端）。best-effort：fire-and-forget，失败 log.warn
 * 留待自愈；不占章预算（定稿是作者动作，摘要失败不该吃下一章的写作预算）。
 * M-2：bookName 在场时登记进后台任务表——删书/改名/优雅退出的 settle 等待能追上
 * 本任务，不再对其落盘窗口逃逸（fire-and-forget 语义不变）。
 */
/** 单次定稿摘要执行（单发/批量串行链共用；异常由调用方包裹留痕） */
async function runFinalizeSummaryOnce(bookRoot: string, userDataPath: string | null, docId: string): Promise<void> {
  const config = effectiveConfig(bookRoot, userDataPath)
  if (!summaryAutoEnabled(config)) return
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const entry = manifest.entries.get(docId)
  if (!entry || !entry.path.startsWith('写作/正文/')) return
  // 从文件名取章号（fm 解析在 findChapterFile 后由 readFile 兜底，这里只定位文件）
  const bodyAbs = join(bookRoot, entry.path)
  if (!existsSync(bodyAbs)) return
  const parsed = parseChapterFileName(entry.path.split('/').pop() ?? '')
  if (!parsed || parsed.章号 <= 0) return
  const r = await generateChapterSummary({
    bookRoot,
    userDataPath,
    config,
    chapter: parsed.章号,
    bodyAbsPath: bodyAbs,
  })
  if (!r.ok) log.warn('summary', `定稿章摘要生成失败（第 ${parsed.章号} 章，留待自愈）：${r.error}`)
}

export function afterFinalizeGenerateSummary(
  bookRoot: string,
  userDataPath: string | null,
  docId: string,
  bookName?: string,
): void {
  const p: Promise<void> = (async () => {
    try {
      await runFinalizeSummaryOnce(bookRoot, userDataPath, docId)
    } catch (e) {
      log.warn('summary', `定稿章摘要钩子异常（${docId}）：${e instanceof Error ? e.message : String(e)}`)
    }
  })()
  // M-2：整段 try-catch 自留痕（p 不 reject）——登记进 per-book 后台表供 settle 追赶
  if (bookName) registerBackgroundTask(bookName, p)
}

/**
 * 批量定稿的串行摘要链（第五轮）：逐章 fire-and-forget 会让一键定稿 N 章 = N 路摘要
 * AI 并发发出（provider 限流整批失败 + 成本尖峰）；同书摘要互不依赖，串行即可。
 * 整条链作为**一条**后台任务登记（M-2）：删书/改名的 settle 在链首即能追上全部在途
 * 与排队中的摘要，「尚未轮到」的任务不产生逃逸窗口。
 */
export function afterFinalizeGenerateSummaryBatch(
  bookRoot: string,
  userDataPath: string | null,
  docIds: string[],
  bookName?: string,
): void {
  if (docIds.length === 0) return
  const p: Promise<void> = (async () => {
    for (const docId of docIds) {
      try {
        await runFinalizeSummaryOnce(bookRoot, userDataPath, docId)
      } catch (e) {
        log.warn('summary', `定稿章摘要钩子异常（${docId}）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })()
  if (bookName) registerBackgroundTask(bookName, p)
}

/**
 * 挂点二（按需自愈，P7-①）：备料前发现近章（N-2 / N-1）摘要缺失或过期 → 现场补生成。
 * 只处理**已定稿**章（manifest finalizedRevision 在位）——给草稿写摘要是浪费；
 * 计入当前写作章 N 的 calls_per_chapter 预算（既有预算闸口径）。
 * 生成后 rebuild 一次让新摘要进 index.db（prepare 的近章结尾从 db 读）。
 */
export async function selfHealRecentChapterSummaries(
  bookRoot: string,
  userDataPath: string | null,
  config: BookConfig,
  currentChapter: number,
): Promise<string[]> {
  if (!summaryAutoEnabled(config)) return []
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const finalizedByChapter = new Map<number, string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    if (!e.path.startsWith('写作/正文/')) continue
    const name = e.path.split('/').pop() ?? ''
    const m = /^(\d+)-/.exec(name)
    if (m) finalizedByChapter.set(Number(m[1]), join(bookRoot, e.path))
  }
  const generated: string[] = []
  for (const ch of [currentChapter - 2, currentChapter - 1]) {
    if (ch < 1) continue
    const bodyAbs = finalizedByChapter.get(ch)
    if (!bodyAbs) continue // 未定稿/不存在：不写摘要
    const state = chapterSummaryState(bookRoot, ch, bodyAbs)
    if (state === 'fresh') continue
    const r = await generateChapterSummary({
      bookRoot,
      userDataPath,
      config,
      chapter: ch,
      bodyAbsPath: bodyAbs,
      budgetChapter: currentChapter,
    })
    if (r.ok && !r.skipped) generated.push(chapterSummaryRelPath(ch))
    else if (!r.ok) log.warn('summary', `自愈补漏失败（第 ${ch} 章）：${r.error}`)
  }
  if (generated.length > 0) {
    // 新摘要文件落盘 → rebuild 同步进 index.db（定稿/ 在 rebuild 源范围内，全量重建由
    // 其三元组基准自动触发）；失败不阻断备料（prepare 只是无这段近章结尾）
    try {
      rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
    } catch (e) {
      log.warn('summary', `摘要 rebuild 失败（备料降级无近章结尾段）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return generated
}

// ── C2（批 3）：卷摘要按需生成 ─────────────────────────────────────────

/** 卷摘要目录（相对书根） */
export const VOLUME_SUMMARY_DIR = join('定稿', '摘要', '卷摘要')

export function volumeSummaryPath(bookRoot: string, volume: number): string {
  return join(bookRoot, VOLUME_SUMMARY_DIR, `${volume}.md`)
}

export function volumeSummaryRelPath(volume: number): string {
  return join(VOLUME_SUMMARY_DIR, `${volume}.md`)
}

/** 第 volume 卷的章号区间（按 volume_size 划卷，与 assembleStatus 同口径） */
export function volumeChapterRange(volume: number, volumeSize: number): { from: number; to: number } {
  return { from: (volume - 1) * volumeSize + 1, to: volume * volumeSize }
}

export interface VolumeChainState {
  /** 该卷全部已定稿章的章摘要（章号 → 摘要正文）；null = 链不全（有定稿章缺摘要） */
  chain: Map<number, string> | null
  /** 链不全时缺失摘要的章号（留痕用） */
  missing: number[]
}

/**
 * 卷摘要链完整性：该卷章号区间内每个**已定稿且正文存在**的章都要有章摘要文件。
 * 章摘要不全 → chain=null（不强行生成——「摘要的摘要」二阶误差红线，逼着先补章摘要）。
 */
export function volumeChainState(bookRoot: string, volume: number, volumeSize: number): VolumeChainState {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const { from, to } = volumeChapterRange(volume, volumeSize)
  const chain = new Map<number, string>()
  const missing: number[] = []
  for (let ch = from; ch <= to; ch++) {
    for (const e of manifest.entries.values()) {
      if (e.nodeType !== 'document' || !e.finalizedRevision) continue
      if (!e.path.startsWith('写作/正文/')) continue
      const m = /^(\d+)-/.exec(e.path.split('/').pop() ?? '')
      if (!m || Number(m[1]) !== ch) continue
      // 该章已定稿：必须有章摘要
      const body = readChapterSummaryBody(bookRoot, ch)
      if (body === null) missing.push(ch)
      else chain.set(ch, body)
    }
  }
  return missing.length > 0 ? { chain: null, missing } : { chain, missing }
}

/** 卷摘要链输入指纹（任一章摘要变动 → 卷摘要过期重生成） */
function volumeChainFingerprint(chain: Map<number, string>): string {
  const h = createHash('sha256')
  for (const ch of [...chain.keys()].sort((a, b) => a - b)) h.update(`${ch}:${chain.get(ch)}\n`)
  return `sha256:${h.digest('hex')}`
}

/**
 * C2（批 3）生成第 volume 卷摘要：输入 = 该卷完整章摘要链（N × summary_chapter_max 字）。
 * 链不全 → 不强行生成（fail-closed，留痕 missing 章），返回 {ok:false}。
 * 链指纹绑 fm.sourceHash——章摘要更新后卷摘要过期重生成。
 */
export async function generateVolumeSummary(opts: {
  bookRoot: string
  userDataPath: string | null
  config: BookConfig
  volume: number
}): Promise<GenerateSummaryResult> {
  const { bookRoot, config, volume } = opts
  const volumeSize = config.book.volume_size ?? 50
  const budget = config.budget.summary_volume_max ?? 500
  const { chain, missing } = volumeChainState(bookRoot, volume, volumeSize)
  if (!chain || chain.size === 0) {
    log.warn('summary', `第 ${volume} 卷章摘要链不全（缺 ${missing.join('、') || '全部'}），卷摘要不强行生成`)
    return { ok: false, error: `第 ${volume} 卷章摘要链不全（缺第 ${missing.join('、')} 章摘要），先补章摘要` }
  }
  const fp = volumeSummaryPath(bookRoot, volume)
  const fingerprint = volumeChainFingerprint(chain)
  // 已有且链未变 → skipped
  if (existsSync(fp)) {
    const m = /^sourceHash:\s*(\S+)/m.exec(readFileSync(fp, 'utf8'))
    if (m && m[1] === fingerprint) return { ok: true, path: fp, skipped: true }
  }
  const chainText = [...chain.keys()]
    .sort((a, b) => a - b)
    .map((ch) => `【第 ${ch} 章】${chain.get(ch)}`)
    .join('\n')
  const userPrompt = [
    `请为第 ${volume} 卷写卷摘要（总长 ≤ ${budget} 字）。`,
    '',
    '## 本卷章摘要链',
    chainText,
  ].join('\n')
  const out = await runSpec(SUMMARY_VOLUME_SPEC, {
    userDataPath: opts.userDataPath,
    userPrompt,
    bookRoot,
    promptFiles: [volumeSummaryRelPath(volume)],
  })
  if (!out.ok) return { ok: false, error: out.error }
  let text = out.data.text.trim()
  if (text.length > budget) text = text.slice(0, budget) + '…'
  if (text.length === 0) return { ok: false, error: 'AI 产出为空' }
  mkdirSync(join(bookRoot, VOLUME_SUMMARY_DIR), { recursive: true })
  const fm = [
    '---',
    `volume: ${volume}`,
    `generatedAt: ${new Date().toISOString()}`,
    // 低级项（第六轮）：占位符 'summary-volume' 换成实际模型 id（mock 快路 → 'unknown'）
    `model: ${out.model ?? 'unknown'}`,
    `sourceHash: ${fingerprint}`,
    '---',
    '',
  ].join('\n')
  atomicWriteFile(fp, fm + text + '\n')
  return { ok: true, path: fp, skipped: false }
}

/**
 * C2（批 3）挂点：备料 rank-3 段需要 `卷摘要/<当前卷-1>.md` 而缺失时按需生成。
 * 与章摘要自愈同闸（summary.auto）。生成成功返回相对路径（prepare 直接读文件，无需 rebuild）。
 */
export async function selfHealVolumeSummary(
  bookRoot: string,
  userDataPath: string | null,
  config: BookConfig,
  currentChapter: number,
): Promise<string | null> {
  if (!summaryAutoEnabled(config)) return null
  const volumeSize = config.book.volume_size ?? 50
  const currentVolume = Math.ceil(currentChapter / volumeSize)
  const targetVolume = currentVolume - 1
  if (targetVolume < 1) return null // 第 1 卷写作中：无上一卷
  const fp = volumeSummaryPath(bookRoot, targetVolume)
  if (existsSync(fp)) {
    // M-7（第六轮）：区分手写与程序生成——手写（无 sourceHash）作者产物优先，永不动；
    // 程序生成但链指纹已变（章摘要更新过）→ 过期，落到下方重生成（原「存在即跳过」
    // 使过期重生成在本挂点不可达）；链不全时 generateVolumeSummary 同样会拒，保留现状
    const m = /^sourceHash:\s*(\S+)/m.exec(readFileSync(fp, 'utf8'))
    if (!m) return null
    const { chain } = volumeChainState(bookRoot, targetVolume, volumeSize)
    if (chain === null || m[1] === volumeChainFingerprint(chain)) return null
  }
  const r = await generateVolumeSummary({ bookRoot, userDataPath, config, volume: targetVolume })
  if (r.ok) return volumeSummaryRelPath(targetVolume)
  log.warn('summary', `上一卷（第 ${targetVolume} 卷）摘要按需生成失败：${r.error}`)
  return null
}
