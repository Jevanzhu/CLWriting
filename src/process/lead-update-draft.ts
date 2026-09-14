/**
 * 账本推进声明生成（W-P1-3 右端：AI 草拟 + 作者确认）。
 *
 * 下沉到 process 层：端点（server/api/lead-updates.ts）与 self-heal 写稿完成后
 * （ai/orchestrate）共用，避免 ai → server 反向依赖。
 *
 * 流程：读本章正文 + 细纲声明推进 + 当前进行中账本 → AI 产出「本章实际写入的履历行」
 * → 解析过滤（存量编号 + 合法动词表）→ 写 工作区/账本推进.md（作者在编辑器确认/修改，
 * finalize 时回写布线履历并清空）。
 */
import { join, relative, sep } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { atomicWriteFile, renameWithRetry } from '../fs/atomic.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { snapshotBeforeOverwrite } from './draft-pipeline.js' // R74-4：覆盖留底单源复用
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { readChapterDir } from '../format/chapters.js'
import { readDraft } from '../format/draft.js'
import { readKind } from '../format/kind.js'
import { runSpec } from '../ai/tasks/spec.js'
import { LEAD_UPDATE_SPEC } from '../ai/tasks/specs.js'
import { readOutlineLeads } from '../check/outline-leads.js'
import { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR, parseLeadUpdateLines } from '../check/lead-updates.js'
import type { ChapterLeadUpdate } from '../check/lead-updates.js'
import { LEAD_VERBS } from '../format/leads.js'
import { readOpenLeads } from './open-leads.js'
import { pruneTextMiddle } from './prune.js'
import { log, errMsg } from '../log/index.js'

// ff-P1-1 常量归一：路径唯一出处 check/lead-updates.ts（闸/回写/草拟三方共用），此处再导出兼容既有导入方
export { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR }

// kk-P2-12a：同书生成串行化队列——端点直调与 self-heal 写稿完成后两路并发时，
// 「archive 旧章草稿 + 覆写主文件」的读改写序列会交错（A 归档后 B 无东西可归档、
// 双写互相覆盖，作者未确认内容丢失）。按 bookRoot 排队执行，跨书不互相阻塞。
const leadUpdateQueues = new Map<string, Promise<unknown>>()

// R73-46（二十一轮）：进程内队列不防**跨进程**双写（GUI 与 CLI 同书各跑各的队列），
// 归档判定与落盘的读改写序列在双进程下仍可交错（B 的 renameSync 撞上 A 已 rename 的
// 源 → ENOENT 误报失败；或归档/覆写交错丢「作者未确认」草稿）。落盘尾段（archive +
// 写主文件）套按书跨进程锁（J7 原语）——AI 生成段（数十秒）不持锁，锁只盖毫秒级文件
// 变更段；拿不到锁降级裸跑 + warn 留痕（与 journal appendLine 同款取舍：生成一次成本
// 高，不因锁等待把整次生成作废）。
/** R73-46 锁等待档（毫秒）——R30-18 口径：const 导出 + 内部可变生效值 + 测试注入钩子
 *  （R32-19：`export let` 违反全仓口径改 const；R32-18：锁等待异步化——调用方
 *  generateLeadUpdateDraft 本就 async，Atomics.wait 微睡不再冻结事件循环）。 */
const LEAD_UPDATE_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let leadUpdateLockTimeoutMs = LEAD_UPDATE_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setLeadUpdateLockTimeoutForTest(ms: number): void {
  leadUpdateLockTimeoutMs = ms
}

async function withLeadUpdateLock<T>(bookRoot: string, fn: () => T): Promise<T> {
  const lockPath = join(bookRoot, LEAD_UPDATES_FILE + '.lock')
  const release = await acquireCrossProcessLockAsync(lockPath, leadUpdateLockTimeoutMs)
  if (!release) {
    log.warn('lead-update-draft', `账本推进锁超时，降级无锁归档+落盘（${lockPath}）——跨进程互斥窗口回到队列口径`)
    return fn()
  }
  try {
    return fn()
  } finally {
    release()
  }
}

/**
 * W-P1-3 右端：生成并落盘 账本推进.md（AI 草拟）。
 * 端点与 self-heal 写稿完成后共用：读本章正文 + 细纲声明 + 进行中账本 → AI 声明实际履历行
 * → 解析过滤（存量编号 + 合法动词）→ 写 工作区/账本推进.md。
 *
 * @param signal Z-P1-1：外部中断信号（self-heal 编排级 / chat 工具层）——
 *               生成随调用方中断同步中止；端点直调（无可中断语境）缺省不传。
 * @returns { ok: true; count: number } 成功（count=0 表示无推进/全被过滤）；
 *          { ok: false; code: 'rejected' | 'not-found' | 'failed'; error: string } 失败
 *          （rejected=业务拒绝如短篇无布线；not-found=正文不存在；failed=AI/落盘失败）。
 */
export async function generateLeadUpdateDraft(
  bookRoot: string,
  chapter: number,
  userDataPath: string | null,
  signal?: AbortSignal,
): Promise<{ ok: true; count: number } | { ok: false; code: 'rejected' | 'not-found' | 'failed'; error: string }> {
  const prev = leadUpdateQueues.get(bookRoot) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(() => generateLeadUpdateDraftInner(bookRoot, chapter, userDataPath, signal))
  leadUpdateQueues.set(bookRoot, run)
  try {
    return await run
  } finally {
    if (leadUpdateQueues.get(bookRoot) === run) leadUpdateQueues.delete(bookRoot)
  }
}

async function generateLeadUpdateDraftInner(
  bookRoot: string,
  chapter: number,
  userDataPath: string | null,
  signal?: AbortSignal,
): Promise<{ ok: true; count: number } | { ok: false; code: 'rejected' | 'not-found' | 'failed'; error: string }> {
  if (readKind(bookRoot) !== 'long') return { ok: false, code: 'rejected', error: '账本推进仅适用于长篇（有布线账本）' }

  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return { ok: false, code: 'not-found', error: '第 ' + chapter + ' 章正文不存在，先写稿再生成账本推进' }

  const draft = readDraft(hit._path)
  if (!draft.ok) return { ok: false, code: 'not-found', error: draft.reason }

  const prompt = buildLeadUpdatePrompt(bookRoot, chapter, draft.body)
  // R-3（第十六轮）：promptFiles 登记真实注入源——prune 后本章正文 + 细纲（若在）。
  // 「进行中账本」段来自 布线/ 等目录聚合（多文件、按状态过滤），无逐文件实路径，
  // 不虚报登记。铁律：模型可见 ⟺ 已记录。
  // R48-59（四十八轮）：细纲登记与水源同门禁——prompt 注入的是 readOutlineLeads 的
  // 产物（声明段），细纲属他章/无声明时内容并未进 prompt，原「文件存在即登记」是
  // 记录侧反向放宽（登记了不可见文件），promptMeta.files 与实际 prompt 分裂。
  const promptFiles = [relative(bookRoot, hit._path).split(sep).join('/')]
  if (readOutlineLeads(bookRoot, chapter).length > 0 && existsSync(join(bookRoot, '工作区', '细纲.md'))) {
    promptFiles.push('工作区/细纲.md')
  }
  // Z-P1-1：signal 桥接进 runSpec——调用方（self-heal/chat）中断时本生成同步中止
  // R48-26（四十八轮）：chapter 透传进预算闸——原 LEAD_UPDATE_SPEC 路径只进 task 块
  // 不进 chapter 块（调用点又绕过 checkAiCallBudget），章内红补生成 + pass 后后台草稿
  // 构成每章 ≤2 次的预算逃逸；对齐 summary.ts generateChapterSummary 的 budgetChapter
  // 口径（runSpec opts.chapter → runTask chapter 块记账）
  const out = await runSpec(LEAD_UPDATE_SPEC, { userDataPath, bookRoot, userPrompt: prompt, signal, promptFiles, chapter })
  if (!out.ok) return { ok: false, code: 'failed', error: out.error }
  const text = out.data.text.trim()
  if (!text) return { ok: false, code: 'failed', error: 'AI 产出为空' }

  const updates = parseLeadUpdateDraft(text, bookRoot)
  const body = updates.length > 0
    ? updates.map((u) => '- ' + u.leadId + ' ' + u.动词 + '：' + u.证据).join('\n')
    : '# 本章无账本推进'
  try {
    // X-P2-6：批量连写下，主文件可能是上一章（尚未定稿确认）的草稿——先按章归档再写本章，
    // finalize（applyLeadUpdates）按定稿章号从归档回收，防止整链旁路丢确认内容。
    // R73-46：归档 + 覆写两步在按书跨进程锁内原子执行（跨进程双写收口，见上注）。
    // R32-18（三十二轮）：withLeadUpdateLock 异步化 → await（R73-46 锁语义不变）
    await withLeadUpdateLock(bookRoot, () => {
      archivePendingLeadUpdates(bookRoot, chapter)
      // R74-4（二十二轮）：覆盖前快照留底（对齐 onboard.ts R71-9 先例）——lead-updates
      // 生成分钟级窗口内作者可经 PUT /file 手改 工作区/账本推进.md（files.ts
      // WORKDIR_EDITABLE 白名单恰含此文件，与生成闸互不相查），完成后覆盖写会把手改
      // 静默丢失。置于 archive 之后：他章草稿已被 rename 归档保全，此处只留底真正将被
      // 覆盖的同章/无标签文件。fail-open：快照失败不阻断主流程（log.warn 留痕——生成
      // 产物不因留底 IO 抖动丢弃，同 R71-9 取舍）。调用方（端点/chat 工具/self-heal
      // 收尾）均为生成路径，无不该留底的反例面。
      const content = `# 第${chapter}章 账本推进\n` + body + '\n'
      try {
        snapshotBeforeOverwrite(bookRoot, LEAD_UPDATES_FILE, content, 'lead-updates-overwrite', undefined, userDataPath)
      } catch (e) {
        log.warn('lead-update-draft', `账本推进覆盖前快照失败（第${chapter}章，fail-open 继续落盘）`, e)
      }
      // 平台规范化批：拼装内容规范形写（updates 的证据段源自库内文本，可能携 \r 残尾）
      atomicWriteFile(join(bookRoot, LEAD_UPDATES_FILE), canonicalizeText(content))
    })
  } catch (e) {
    return { ok: false, code: 'failed', error: '落盘:' + (errMsg(e)) }
  }
  return { ok: true, count: updates.length }
}

/**
 * 主文件若载有**其他章**的待确认条目 → 归档到 工作区/.账本推进暂存/第N章.md（X-P2-6）。
 * 同章重生成（自愈循环复查）直接覆盖不归档；无条目（空/无推进）不归档；无标签旧文件不归档
 * （语义上视为当前章，保持单章模式旧行为）。
 */
export function archivePendingLeadUpdates(bookRoot: string, forChapter: number): void {
  const file = join(bookRoot, LEAD_UPDATES_FILE)
  if (!existsSync(file)) return
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return
  }
  const hasEntries = raw.split('\n').some((l) => l.trim().startsWith('-'))
  if (!hasEntries) return
  // R2W-2（win 平台专项复审 R2）：剥首行 BOM——记事本「UTF-8 with BOM」保存后 ^# 不中
  // → 误判「无标签旧格式」跳过归档 → 他章待确认推进草稿被下次生成静默覆盖丢失
  // （读侧孪生 check/lead-updates.ts readLeadUpdateChapterTag 的 R33D-3 同族写侧补齐）。
  const m = (raw.replace(/^\uFEFF/, '').split('\n', 1)[0] ?? '').match(/^#\s*第(\d+)章/)
  if (!m) return // 无标签旧格式 → 视为当前章，保持覆盖语义
  const tag = Number(m[1])
  if (tag === forChapter) return
  const dir = join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR)
  mkdirSync(dir, { recursive: true })
  // MP2-3（专项重评二轮修复批）：归档 rename 收编 renameWithRetry——win 瞬时锁
  // （EPERM/EBUSY）退避后再失败仍上抛（调用方 WRITE_ERROR 可重试，语义不变）
  const standardDst = join(dir, `第${tag}章.md`)
  if (!existsSync(standardDst)) {
    renameWithRetry(file, standardDst)
    return
  }
  // 全库重评-0914 P2-5：标准名已存在时原落时间戳变体——但两读侧（check/run.ts 批量
  // 预扫 `^第(\d+)章\.md$` 与 lead-updates.chapterUpdateSources 精确路径）均只认标准
  // 名，第二代归档对两端闭合判定与 finalize 回写完全不可见（声明静默失联：闸不查、
  // 定稿不回写）。改为读旧档 + 按（编号,动词）归并重写标准名：同键新声明覆盖旧（与
  // 履历回写按编号归并口径一致；旧证据在章文重生成后 needle 必败，保留反造假红硬
  // 阻断定稿），其余旧条目保序保全，新条目按新序追加。
  let oldRaw: string
  try {
    oldRaw = readFileSync(standardDst, 'utf-8')
  } catch (e) {
    // 旧档读失败：宁保两代不损——回落时间戳变体（L-P6 保底语义，见下）
    log.warn('lead-update-draft', `归档目标已存在但读取失败（${standardDst}），回落时间戳变体保全两代`, e)
    renameWithRetry(file, join(dir, `第${tag}章-${Date.now()}.md`))
    return
  }
  const newEntries = parseLeadUpdateLines(raw)
  if (newEntries.length === 0) {
    // 新档解析零条目（仅格式不符的 `-` 行/备注）：归并会把旧档非条目文本一并冲掉，
    // 无条目可并时回落时间戳变体（原文两代均从盘上可恢复）
    renameWithRetry(file, join(dir, `第${tag}章-${Date.now()}.md`))
    return
  }
  // L-P6（第八轮）语义延续：同章旧「未确认推进草稿」仍不静默丢失——可解析条目全数
  // 保全（仅同键旧证据被新声明覆盖），并留痕归并账目。
  const merged = mergeLeadUpdateEntries(tag, parseLeadUpdateLines(oldRaw), newEntries)
  atomicWriteFile(standardDst, canonicalizeText(merged.text))
  // 归并落盘后源文件删除；ENOENT（他进程已移走）无害，其余失败留痕（调用方随即覆写
  // 主文件，条目已全数并入标准名，不构成草稿丢失）
  try {
    rmSync(file, { force: true })
  } catch (e) {
    log.warn('lead-update-draft', `归档归并后源文件删除失败（${file}）——条目已并入第${tag}章.md`, e)
  }
  log.info('lead-update-draft', `归档归并 第${tag}章.md：旧 ${merged.oldCount} 条 + 新 ${merged.added} 条 + 覆盖 ${merged.overridden} 条 → ${merged.total} 条`)
}

/** P2-5 归并纯函数：旧条目保序保位（档内同键重复收敛到末次声明），同键新声明覆盖
 *  旧证据，新键按新声明顺序追加。key = （编号, 动词）——与履历回写按编号归并的口径
 *  一致（同编号同动词视为同一声明的新版本）。 */
export function mergeLeadUpdateEntries(
  tag: number,
  oldEntries: readonly ChapterLeadUpdate[],
  newEntries: readonly ChapterLeadUpdate[],
): { text: string; oldCount: number; added: number; overridden: number; total: number } {
  const out: ChapterLeadUpdate[] = []
  const index = new Map<string, number>()
  const keyOf = (u: ChapterLeadUpdate): string => u.leadId + '\u0000' + u.动词
  const put = (u: ChapterLeadUpdate): boolean => {
    const k = keyOf(u)
    const i = index.get(k)
    if (i === undefined) {
      index.set(k, out.length)
      out.push({ ...u })
      return true
    }
    out[i] = { ...u }
    return false
  }
  for (const u of oldEntries) put(u) // 旧档内重复：末次声明为准（读侧本就会双计，归并收敛）
  let added = 0
  let overridden = 0
  for (const u of newEntries) {
    if (put(u)) added++
    else overridden++
  }
  const lines = out.map((u) => '- ' + u.leadId + ' ' + u.动词 + '：' + u.证据)
  return {
    text: `# 第${tag}章 账本推进\n` + lines.join('\n') + '\n',
    oldCount: oldEntries.length,
    added,
    overridden,
    total: out.length,
  }
}

/**
 * 组账本推进 prompt：正文 + 细纲声明 + 进行中账本 → AI 声明「本章实际写入的履历行」。
 * 关键约束：证据必须是正文原句（readChapterLeadUpdates 用 evidenceNeedles 多候选命中正文才算兑现，R63-8），
 * 动词须匹配该线合法动词表（LEAD_VERBS），编号须为存量进行中账本。
 */
export function buildLeadUpdatePrompt(bookRoot: string, chapter: number, body: string): string {
  const declared = readOutlineLeads(bookRoot, chapter)
  const open = readOpenLeads(bookRoot)
  const parts: string[] = [
    '## 任务\n为第 ' + chapter + ' 章生成「账本推进声明」——AI 写完本章后声明本章**实际**推进了哪些账本线。',
    // A3：超长正文无通知硬切 slice(0,6000) → 修剪器头尾保留（账本证据常在章尾）。
    // 预算对齐原值：4800+1024+marker ≈ 5850 < 6000，可见量不增、多覆盖尾部且明示省略
    '## 本章正文\n' + pruneTextMiddle(body, { threshold: 6000, head: 4800, tail: 1024 }),
  ]
  if (declared.length > 0) {
    parts.push('## 细纲声明推进（计划，本章应兑现；实际写砸了可如实降级/不推进）\n' + declared.join('、'))
  }
  if (open.length > 0) {
    parts.push(
      '## 进行中账本（编号 + 合法动词表，仅可从这些编号中选择）\n' +
        open
          .map((l) => {
            const type = l.编号.split('-')[0] as keyof typeof LEAD_VERBS
            const verbs = LEAD_VERBS[type]
            return '- ' + l.编号 + ' ' + l.标题 + '（' + l.状态 + '） 动词:[' + (verbs ? verbs.advance.join('/') : '') + ']'
          })
          .join('\n'),
    )
  }
  parts.push(
    '## 输出\n直接输出账本推进行列表（每行一个，- 开头）：\n  - <编号> <动词>：<证据>\n其中 <证据> 必须是本章正文的**原句**（机检据此核对兑现，非原句会被判未兑现）；\n只列本章真正推进/开启/揭晓的线；本章无推进则输出「无推进」三个字。',
  )
  return parts.join('\n\n')
}

/**
 * 解析 AI 产出的账本推进草稿 → 合法 ChapterLeadUpdate[]。
 * 与 check/lead-updates.ts 读取格式同构（- <编号> <动词>：<证据>）；
 * 过滤：编号必须命中存量进行中账本、动词必须命中该线 advance/resolve/open 动词表。
 */
export function parseLeadUpdateDraft(text: string, bookRoot: string): { leadId: string; 动词: string; 证据: string }[] {
  const open = new Set(readOpenLeads(bookRoot).map((l) => l.编号))
  const out: { leadId: string; 动词: string; 证据: string }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('-')) continue
    const m = line.match(/^-\s*(\S+)\s+([^\s:：]+)[:：]\s*(.+)$/)
    if (!m) continue
    const leadId = m[1]!.trim()
    const 动词 = m[2]!.trim()
    const 证据 = m[3]!.trim()
    if (!open.has(leadId) || !证据) continue
    const type = leadId.split('-')[0] as keyof typeof LEAD_VERBS
    const verbs = LEAD_VERBS[type]
    if (!verbs) continue
    const valid = [...verbs.open, ...verbs.advance, ...verbs.resolve, ...verbs.drop]
    if (!valid.includes(动词)) continue
    out.push({ leadId, 动词, 证据 })
  }
  return out
}
