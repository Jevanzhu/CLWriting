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
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { walkMdFind } from '../fs/walk-md.js'
import { chapterNamePrefixes, parseChapterFileName } from '../format/chapters.js'
import { splitFrontMatter } from '../format/frontmatter-core.js'
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
import { acquireCrossProcessLockWithTimeout } from '../fs/cross-process-lock.js'

// N-7（第五十四轮）：预算兜底显式声明——summary_chapter_max / summary_volume_max 不在
// applyGlobalDefaults 全局默认链内（书级不设即 undefined），此值即实际生效的最终回落，
// 与 format/yaml.ts 脚手架默认（200/500）同源；提取具名常量保证「默认值显式 resolve」
// 可回溯（重放时可精确重建最终值）。
/** 章摘要字数上限最终回落（书级 summary_chapter_max 未设时生效；200，与 yaml 脚手架缺省一致） */
export const SUMMARY_CHAPTER_MAX_FALLBACK = 200
/** 卷摘要字数上限最终回落（书级 summary_volume_max 未设时生效；500，与 yaml 脚手架缺省一致） */
export const SUMMARY_VOLUME_MAX_FALLBACK = 500

/** R-11（十五轮登记销账）：按码位截断（Array.from 迭代码点）——String.slice 按
 *  UTF-16 码元，增补平面字符在边界处被切成半个代理对；章/卷摘要硬截断两处对齐
 *  全库 code point 口径（P-7 estimateTokens / format/filename 同源）。 */
// R64-6（十二轮）导出：ai/tools/rewrite.ts 预览切片收编码点口径（第 4 处消费方）
export function clipByCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** N-14（第五十四轮）：码位计数——自增计数器逐码点数，替代 `[...text].length`
 *  全量展开数组只为取个数的写法（截断路径每次落盘都过这里）；口径严格不变：
 *  代理对（高低各一码元）算一个码位，孤立代理项各算一个，与展开结果一致。 */
export function codePointLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 高代理项后随低代理项 → 成对算一个码位，跳过低代理项
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** 章摘要目录（相对书根）。R71-15（总七十一轮）：posix 字面量——join() 消费点
 *  （chapterSummaryPath/mkdirSync）会自动归一到平台分隔符，而相对路径消费点
 *  （promptFiles/留痕）要求与全库 posix 归一口径（draft-pipeline F2）一致 */
export const CHAPTER_SUMMARY_DIR = '定稿/摘要/章摘要'

/** 摘要文件路径（纯数字 stem——scanSummaries 的 Number() 归集口径） */
export function chapterSummaryPath(bookRoot: string, chapter: number): string {
  return join(bookRoot, CHAPTER_SUMMARY_DIR, `${chapter}.md`)
}

/** 摘要相对书根路径（promptMeta.files 登记用） */
export function chapterSummaryRelPath(chapter: number): string {
  // R71-15：登记/留痕路径不得产平台分隔符（win 反斜杠与全库 posix 口径分裂）——
  // 显式 '/' 拼接（只进事件记录不进 fs，join 消费走 chapterSummaryPath）
  return [CHAPTER_SUMMARY_DIR, `${chapter}.md`].join('/')
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
  // R65-31（第六十五轮）：existsSync 后裸 read 直穿自愈链（权限/TOCTOU 读失败抛出）——
  // 包 try/catch 按缺失降级 + warn（下次自愈按 missing 重新生成）
  let raw: string
  try {
    raw = readFileSync(fp, 'utf8')
  } catch (e) {
    log.warn('summary', `章摘要读取失败（第 ${chapter} 章，按缺失降级）：${e instanceof Error ? e.message : String(e)}`)
    return 'missing'
  }
  // Q-14（第十五轮）：改走 frontmatter-core 统一提取——手写正则不处理 BOM/CRLF，
  // 带 BOM 的摘要文件 fm 整段丢失 → 过期检测永久失灵
  const split = splitFrontMatter(raw)
  if (!split) return 'fresh' // 手写摘要（无 fm）：作者优先
  const hashMatch = /^sourceHash:\s*(\S+)/m.exec(split.fmRaw)
  if (!hashMatch) return 'fresh' // 有 fm 无指纹：同样按作者产物对待
  return hashMatch[1] === computeRevision(bodyAbsPath) ? 'fresh' : 'stale'
}

/** 解析章摘要正文（剥 fm——prepare 注入用内容的同源读取） */
export function readChapterSummaryBody(bookRoot: string, chapter: number): string | null {
  const fp = chapterSummaryPath(bookRoot, chapter)
  if (!existsSync(fp)) return null
  // R65-31：读失败（权限/TOCTOU）按 null 降级 + warn，不再直穿调用链
  let raw: string
  try {
    raw = readFileSync(fp, 'utf8')
  } catch (e) {
    log.warn('summary', `章摘要读取失败（第 ${chapter} 章，按无摘要降级）：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  // Q-14：同上走 frontmatter-core（剥 fm 口径与全库一致，BOM/CRLF 不再漏进注入正文）
  const split = splitFrontMatter(raw)
  return (split ? split.body : raw).trim()
}

/** 在 写作/正文/（含卷子目录）按章号找正文文件；找不到 → null。
 *  L-P1（第八轮）：走共享 walkMdFind（环剪枝 + 起遍目录根界）——原先手写递归无
 *  visited（书内 symlink 环深递归）也无根界（书外 symlink 被跟随整读）。 */
export function findChapterFile(bookRoot: string, chapter: number): string | null {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  const prefixes = chapterNamePrefixes(chapter)
  return walkMdFind(bodyDir, (abs, name) =>
    prefixes.some((p) => name.startsWith(p)) ? abs : undefined,
  ) ?? null
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
  /** R76-5（二十四轮 A 域）：编排级中断信号（Z-P1-1 同款）——备料补漏路径传入，中断时
   *  在途 LLM 调用即时收口而非各跑到自身超时（分钟级白烧 token + running 迟迟不释放）。 */
  signal?: AbortSignal
}

export type GenerateSummaryResult =
  | { ok: true; path: string; skipped: boolean }
  | { ok: false; error: string }

/** 同章在途去重：批量定稿并发触发 / 自愈与定稿钩子同时命中时不重复调用 */
const inFlight = new Set<string>()

// R26-19（二十六轮）：摘要生成跨进程互斥锁——GUI 与 CLI 双开同书时，定稿钩子与备料自愈
// 两路各自的进程内 inFlight 互相看不见，同一章的「状态判定（stale/missing）→ AI 调用 →
// 落盘」会在两个进程里各跑一遍：重复调 AI 重复计费，且后写者覆盖先写者产物。对临界段套
// 按章跨进程锁（J7 原语，lead-update-draft / learn-harvest 同款用法）；锁文件放 工作区/
// 下、按生成目标分把——粒度与 inFlight 键一致，同进程不同章并发互不阻塞（若合成按书一把，
// 章摘要串行链之外的两章并发会白等锁超时）。锁盖全临界段（状态判定在内——锁外判状态
// 会重开 TOCTOU 窗口），AI 调用数十秒在所难免；拿不到锁 → 本调用返回
// { ok: true, skipped: true }：语义 = 他人正在生成/已完成，不是失败（同时解决 R26-101——
// 并发去重命中不再被调用方当「自愈失败」warn 留痕），漏生窗口由既有自愈兜底。
// R28-15（二十八轮）：锁等待档 5s → 0（非阻塞 try-acquire，拿不到即跳过本轮）。理由：
// 锁原语的等待是 Atomics.wait 同步微睡（Node 主线程合法但整段阻塞事件循环），而持锁方
// 是分钟级 AI 调用——GUI（Electron 主进程，IPC 敏感）与 CLI 双开同书时，第二进程为一把
// 几乎不可能在等待档内释放的锁同步阻塞整个等待档，纯付出零收益（300ms 档同理不成立：
// 仍冻结主进程且等不到分钟级持锁面）。两路挂点（定稿钩子 fire-and-forget / 备料自愈）
// 对 skipped 的消费语义本就是「他人正在生成/已完成，非失败」，跳过一轮无害、自愈兜底
// 照旧。0 档不影响陈锁接管：tryAcquire 内部的死 pid 判 stale + jitter + 重建不受等待档
// 约束，崩溃残留不永锁的语义保留。
/** R26-19 锁等待档（毫秒；R28-15 起生产固定 0 = 纯 try-acquire）——模块内 let + ForTest 注入钩子（R26-105 收口惯例：不裸导出变量本体）。 */
let SUMMARY_GENERATE_LOCK_TIMEOUT_MS = 0
/** 测试注入钩子（生产零调用）。 */
export function __setSummaryGenerateLockTimeoutForTest(ms: number): void {
  SUMMARY_GENERATE_LOCK_TIMEOUT_MS = ms
}

/**
 * R27-105（二十七轮）：锁续期周期（毫秒）——锁盖「状态判定 + AI 调用 + 落盘」全临界段
 * （R26-19），而锁原语的活 pid 超龄门槛（Z-19）与 AI 任务默认超时同为 10 分钟：两处锁
 * 调用不传 renewIntervalMs 时锁文件 mtime 恒为创建时刻，AI 调用一超 10min（慢派发/限流
 * 重试），第二进程按「活 pid 超龄且无续期」接管成双持锁 → 同一章/卷双生成双计费，
 * 跨进程互斥被静默击穿。接线锁原语既有续期能力（N6；task-gate R71-3 同款）：30s 刷一次
 * mtime 远低于超龄门槛，活锁不再被误接管。模块内 let + ForTest 注入钩子（R26-105 惯例）
 * 保测试可缩周期。
 */
let SUMMARY_LOCK_RENEW_MS = 30_000
/** 测试注入钩子（生产零调用）。 */
export function __setSummaryLockRenewMsForTest(ms: number): void {
  SUMMARY_LOCK_RENEW_MS = ms
}

/**
 * 生成（或按 sourceHash 过期重生成）一章摘要。fresh → skipped 不调 AI。
 * 产出硬约束：三行结构由 system prompt 约定；字数上限 prompt 声明 + 落盘前硬截断
 * （确定性上限，不信任模型自觉）。
 * R26-19：进程内 inFlight 快速去重 + 按章跨进程锁盖「状态判定 + AI 调用 + 落盘」全临界段；
 * 两路去重命中一律返回 skipped: true（他人正在生成/已完成，不是失败）。
 */
export async function generateChapterSummary(opts: GenerateChapterSummaryOpts): Promise<GenerateSummaryResult> {
  const { bookRoot, chapter, bodyAbsPath } = opts
  const fp = chapterSummaryPath(bookRoot, chapter)
  // 同进程快速去重（保留）：并发去重命中 = 本进程已在生成，语义同锁超时（skipped 非失败）
  const key = `${bookRoot}#${chapter}`
  if (inFlight.has(key)) return { ok: true, path: fp, skipped: true }
  // R26-19：跨进程锁（锁内才判状态——锁外判会重开「判完他进程开写」的 TOCTOU 窗口）
  // R27-105：接线 N6 续期——持锁面覆盖全长 AI 调用，不续期会被第二进程按超龄接管成双持锁
  const releaseLock = acquireCrossProcessLockWithTimeout(
    // R28-14（二十八轮）：锁名补 .lock 后缀——fs/atomic sweepAbandonedTmpFiles 的陈锁
    // 清扫分支只认 `*.lock`（R76-27），此前 `.摘要锁-章N` 永不命中：崩溃残留锁只能靠
    // stale 接管对冲，锁主人不再有获取者时（产物已 purge 等）永久堆积。后缀不参与锁
    // 身份判定语义之外的任何事（锁身份 = 全路径，改名对新旧锁互不相认——旧残留由
    // sweep/超龄接管收口，不存在兼容问题）。
    join(bookRoot, '工作区', `.摘要锁-章${chapter}.lock`),
    SUMMARY_GENERATE_LOCK_TIMEOUT_MS,
    { renewIntervalMs: SUMMARY_LOCK_RENEW_MS },
  )
  // 拿不到锁 = 他进程正在生成/已完成：skipped（非失败），漏生由自愈兜底
  if (!releaseLock) return { ok: true, path: fp, skipped: true }
  inFlight.add(key)
  try {
    const state = chapterSummaryState(bookRoot, chapter, bodyAbsPath)
    if (state === 'fresh') return { ok: true, path: fp, skipped: true }
    const budget = opts.config.budget.summary_chapter_max ?? SUMMARY_CHAPTER_MAX_FALLBACK
    // R66-18（十四轮）：正文与指纹此前两次独立读盘（readDraft 一次 + computeRevision
    // 一次）——两读之间正文被改（H1→H2）会把 H2 的指纹绑给 H1 正文的摘要；改单次读
    // Buffer 同源派生 body（readDraft 的 R63-7 content 通道）与哈希。
    // 哈希字节口径逐字对齐 fs/hash.ts hashFile / document/revision.ts computeRevision
    //（'sha256:' + 原始字节 SHA-256；src/fs 不在本批可写域，不重复开 import 面）。
    let raw: Buffer
    try {
      raw = readFileSync(bodyAbsPath)
    } catch (e) {
      return { ok: false, error: `读正文失败：${e instanceof Error ? e.message : String(e)}` }
    }
    // R72-7（二十轮 C-1）：非 UTF-8 正文拒绝生成摘要——GBK 等文件以 utf-8 解码出 U+FFFD
    // 后喂 AI 生成摘要再回写，摘要静默失真且被指纹绑定（过期判定认它为 fresh，永不再生）。
    // 判据与保存链 M-5 闸（document/service.isUtf8Bytes）同款 fatal 解码探测，补齐防线
    // 不对称（搬运 fs 底座另行收编，此处先同算法内联）。
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      return { ok: false, error: '正文不是合法 UTF-8 编码，拒绝生成摘要（请先修复文件编码）' }
    }
    const draft = readDraft(bodyAbsPath, raw.toString('utf8'))
    if (!draft.ok) return { ok: false, error: `读正文失败：${draft.reason}` }
    // 第五轮：指纹取读取时点（现为同一 Buffer，杜绝第二读的时点漂移）——AI 生成窗口
    // （数十秒）内正文若被再改并再次定稿（H2），写盘时才算会把 H2 指纹绑给 H1 正文的
    // 摘要：过期判定从此恒 fresh，自愈与定稿钩子都被挡住，过期摘要长期喂后续章节的
    // 「近章结尾」材料。取读取时点的 H1，H2 到来后过期判定正常触发重生成。
    const sourceHash = 'sha256:' + createHash('sha256').update(raw).digest('hex')
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
      ...(opts.signal ? { signal: opts.signal } : {}),
      // R-2（第十六轮）：登记真实注入源——模型实际读的是 draft.body（正文全文），
      // 此前登记输出文件（定稿/摘要/章摘要/N.md）属溯源虚报；改为登记正文相对路径
      promptFiles: [relative(bookRoot, bodyAbsPath).split(sep).join('/')],
    })
    if (!out.ok) return { ok: false, error: out.error }

    // 硬截断到预算（确定性上限；模型超长不信任）
    let text = out.data.text.trim()
    // R-11（十五轮登记销账）：截断按码位——slice 按 UTF-16 码元，增补平面字符（生僻
    // 字/emoji）在边界处被切成半个代理对落盘；全库截断口径 code point（P-7/filename 同源）
    // E-9e（第五十三轮）：预算比较也按码位——此前 UTF-16 length 与码位预算混用，含
    // 增补平面字符时 length 偏大、截断点略偏（截断本身已是码位口径 clipByCodePoints）
    if (codePointLength(text) > budget) text = clipByCodePoints(text, budget) + '…'
    if (text.length === 0) return { ok: false, error: 'AI 产出为空' }

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
    releaseLock()
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
  writingChapter: number, // L-P3n（第八轮）：语义=正在写的章号 N（自愈 N-2/N-1），非 assembleStatus 的 currentChapter（最后定稿章）——同名不同义极易接错
  signal?: AbortSignal, // R76-5：编排级中断透传（备料补漏路径）
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
  for (const ch of [writingChapter - 2, writingChapter - 1]) {
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
      budgetChapter: writingChapter,
      ...(signal ? { signal } : {}), // R76-5：中断透传到在途 LLM 调用
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

/** 卷摘要目录（相对书根）。R71-15：posix 字面量（同 CHAPTER_SUMMARY_DIR 口径） */
export const VOLUME_SUMMARY_DIR = '定稿/摘要/卷摘要'

export function volumeSummaryPath(bookRoot: string, volume: number): string {
  return join(bookRoot, VOLUME_SUMMARY_DIR, `${volume}.md`)
}

export function volumeSummaryRelPath(volume: number): string {
  // R71-15：登记/留痕路径 posix 归一（同 chapterSummaryRelPath）
  return [VOLUME_SUMMARY_DIR, `${volume}.md`].join('/')
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
    // L-P4（第八轮）：同章多条定稿条目（改名重定稿等）只计一次——原先每条都 push
    // missing，错误文案重复；匹配到首条即跳出内层循环
    let finalized = false
    for (const e of manifest.entries.values()) {
      if (e.nodeType !== 'document' || !e.finalizedRevision) continue
      if (!e.path.startsWith('写作/正文/')) continue
      const m = /^(\d+)-/.exec(e.path.split('/').pop() ?? '')
      if (!m || Number(m[1]) !== ch) continue
      finalized = true
      break
    }
    if (!finalized) continue
    // 该章已定稿：必须有章摘要
    const body = readChapterSummaryBody(bookRoot, ch)
    if (body === null) missing.push(ch)
    else chain.set(ch, body)
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
  signal?: AbortSignal // R76-5：编排级中断透传（备料补漏路径）
}): Promise<GenerateSummaryResult> {
  const { bookRoot, config, volume } = opts
  const volumeSize = config.book.volume_size ?? 50
  const budget = config.budget.summary_volume_max ?? SUMMARY_VOLUME_MAX_FALLBACK
  const fp = volumeSummaryPath(bookRoot, volume)
  // R26-19（二十六轮）：卷摘要对齐章摘要同款两级去重——进程内 inFlight 快速去重 +
  // 按卷跨进程锁盖「链完整性判定 + AI 调用 + 落盘」全临界段（GUI/CLI 双开同书防重复
  // 调 AI 重复计费）；去重命中一律 skipped: true（他人正在生成/已完成，非失败），
  // 状态判定挪进锁内（锁外判会重开 TOCTOU 窗口）。
  const volKey = `${bookRoot}#vol${volume}`
  if (inFlight.has(volKey)) return { ok: true, path: fp, skipped: true }
  // R27-105：接线 N6 续期（同章摘要锁）——链完整性判定 + AI 调用 + 落盘全临界段在持锁面内
  const releaseLock = acquireCrossProcessLockWithTimeout(
    // R28-14（二十八轮）：锁名补 .lock 后缀（同章摘要锁——sweep 陈锁清扫分支只认 *.lock）
    join(bookRoot, '工作区', `.摘要锁-卷${volume}.lock`),
    SUMMARY_GENERATE_LOCK_TIMEOUT_MS,
    { renewIntervalMs: SUMMARY_LOCK_RENEW_MS },
  )
  if (!releaseLock) return { ok: true, path: fp, skipped: true }
  inFlight.add(volKey)
  try {
    const { chain, missing } = volumeChainState(bookRoot, volume, volumeSize)
    if (!chain || chain.size === 0) {
      log.warn('summary', `第 ${volume} 卷章摘要链不全（缺 ${missing.join('、') || '全部'}），卷摘要不强行生成`)
      return { ok: false, error: `第 ${volume} 卷章摘要链不全（缺第 ${missing.join('、') || '全部'} 章摘要），先补章摘要` }
    }
    const fingerprint = volumeChainFingerprint(chain)
    // 已有且链未变 → skipped（R65-31：sourceHash 重读包 try/catch——读失败（权限/TOCTOU）
    // 按指纹不匹配降级（视同缺失，落到下方重生成路径）+ warn，不直穿生成链）
    if (existsSync(fp)) {
      let volRaw: string | null = null
      try {
        volRaw = readFileSync(fp, 'utf8')
      } catch (e) {
        log.warn('summary', `卷摘要读取失败（第 ${volume} 卷，按缺失降级重生成）：${e instanceof Error ? e.message : String(e)}`)
      }
      const m = volRaw !== null ? /^sourceHash:\s*(\S+)/m.exec(volRaw) : null
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
      ...(opts.signal ? { signal: opts.signal } : {}), // R76-5：中断透传到在途 LLM 调用
      // R-2（第十六轮）：登记真实注入源——模型实际读的是章摘要链（chainText），
      // 此前登记输出文件（定稿/摘要/卷摘要/N.md）属溯源虚报；改为登记实际注入的
      // 章摘要文件列表（链内章号 → 章摘要路径，按注入序）
      promptFiles: [...chain.keys()].sort((a, b) => a - b).map((ch) => chapterSummaryRelPath(ch)),
    })
    if (!out.ok) return { ok: false, error: out.error }
    let text = out.data.text.trim()
    // R-11（十五轮登记销账）：同章摘要——码位截断，不切半个代理对
    // E-9e（第五十三轮）：预算比较也按码位——此前 UTF-16 length 与码位预算混用，含
    // 增补平面字符时 length 偏大、截断点略偏（截断本身已是码位口径 clipByCodePoints）
    if (codePointLength(text) > budget) text = clipByCodePoints(text, budget) + '…'
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
  } finally {
    inFlight.delete(volKey)
    releaseLock()
  }
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
  signal?: AbortSignal, // R76-5：编排级中断透传（备料补漏路径）
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
    // R65-31：读失败（权限/TOCTOU）按手写产物降级（m=null → return null 不动文件）——
    // 读不出的文件贸然重生成会覆盖不可见内容，宁不动 + warn
    let volRaw: string | null = null
    try {
      volRaw = readFileSync(fp, 'utf8')
    } catch (e) {
      log.warn('summary', `卷摘要读取失败（第 ${targetVolume} 卷，按手写产物跳过不动）：${e instanceof Error ? e.message : String(e)}`)
    }
    const m = volRaw !== null ? /^sourceHash:\s*(\S+)/m.exec(volRaw) : null
    if (!m) return null
    const { chain } = volumeChainState(bookRoot, targetVolume, volumeSize)
    // R27-107（二十七轮）：链不全时链指纹无从计算（既不能证新也不能证旧），此前与
    // 「fresh」合用一个 return 静默放弃——交集路径无留痕，备料侧照注入旧文件无人知晓。
    // 「保留现有文件、不强行生成」的取舍不变（二阶误差红线），只补留痕（对齐模块 warn 风格）
    if (chain === null) {
      log.warn('summary', `第 ${targetVolume} 卷章摘要链不全，卷摘要新鲜度无法判定，放弃按需重生成（保留现有文件）`)
      return null
    }
    if (m[1] === volumeChainFingerprint(chain)) return null
  }
  const r = await generateVolumeSummary({ bookRoot, userDataPath, config, volume: targetVolume, ...(signal ? { signal } : {}) })
  if (r.ok) return volumeSummaryRelPath(targetVolume)
  log.warn('summary', `上一卷（第 ${targetVolume} 卷）摘要按需生成失败：${r.error}`)
  return null
}

/**
 * R27-107（二十七轮）：备料陈旧闸判据（prepare 弹性#3 注入前查询）——「可证明过期」
 * 仅指：程序生成（fm 带 sourceHash）+ 当前链完整非空 + 链指纹不匹配。手写产物（M-7
 * 作者优先）、链不全（指纹无从计算）、空链（退化指纹无比较意义，legacy/无清单书一律
 * 放行）、读失败（R65-31 宁不动）一律 false——宁窄勿误杀，闸只拦「拿得出指纹证明
 * 落后于当前卷状态」的形态；留痕归调用方（谁放弃注入谁留痕）。
 */
export function volumeSummaryProvablyStale(bookRoot: string, volume: number, volumeSize: number): boolean {
  let volRaw: string
  try {
    volRaw = readFileSync(volumeSummaryPath(bookRoot, volume), 'utf8')
  } catch {
    return false // 读失败无法证明过期（R65-31 同款保守：宁注入路径自行降级，不在这里下判）
  }
  const m = /^sourceHash:\s*(\S+)/m.exec(volRaw)
  if (!m) return false // 手写产物：作者优先，不按程序指纹判旧
  const { chain } = volumeChainState(bookRoot, volume, volumeSize)
  if (chain === null || chain.size === 0) return false // 链不全/空链：无法证明过期
  return m[1] !== volumeChainFingerprint(chain)
}
