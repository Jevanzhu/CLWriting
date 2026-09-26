/**
 * 章节结构操作公共底座（读态派生 / plan 指纹 / 折叠拼接 / 事件副录 / 取号）。
 *
 * （⑤④产品巨件拆分波2）：自 structure.ts 三缝一体纯移动拆分而来
 * （纯移动——代码与注释原样随迁，零行为变化）。设计口径正本 = structure.ts 头注
 * （《章节结构操作-设计方案-》v3）。本文件承载原「公共形状」段的
 * StructureFailure / StructureRagPort 与原「内部工具」段全部内容（ChapterDiskState
 * 单读派生 / fail / plan 指纹族 / foldMergedInto / concatChapterBody / bodyStartOffset /
 * recordStructureEvents / maxUsedChapter / finalizedChapterNumbers / skipFinalized /
 * splitOrderMid / realpathOf / newestVersionWithoutSource）；structure-merge.ts 与
 * structure-split.ts 单向依赖本文件（core←merge/split，无环）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { canonicalizeText } from '../fs/text-canonical.js'
import { readMdTextCached } from '../fs/md-text-cache.js'
import { walkMdEach } from '../fs/walk-md.js'
import { safeManifestPath } from '../fs/safe-path.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import { parseMergedInto, parseOrderOf } from '../format/chapters.js'
import { mergedIntoMap } from '../format/chapter-lookup.js'
// 0918修复批（B005 尾项）：isMdFileName = 定稿条目章号提取剥 .md 茎单源
import { chapterNoFromName, isMdFileName } from '../format/filename.js'
import { layoutOf } from './layout.js'
import { readManifestStrict } from './manifest.js'
import { readVersion, listVersions } from './version.js'
import type { DocumentService } from './service.js'
import { openSessionStoreAsync, bookHash, type NewEvent, type SessionStore } from '../events/store.js'
import { log, errMsg } from '../log/index.js'

// ── 公共形状 ─────────────────────────────────────────────────────────

export type StructureFailure = { ok: false; code: string; reason: string }

/**
 * RAG 触点端口（依赖方向守护的接口反转）：document 底座不得 import rag 生成层，
 * 干跑预估与合并后清理由合法调用层（studio/server/api）注入 rag/index 实现。方法名
 * 与被代理函数一致（适配零成本）；等价性由 structure-merge/split 端点级 RAG 用例钉定
 * （经 api 层走真实现，本文件零 rag 依赖可独立单测）。
 */
export interface StructureRagPort {
  estimateRagChunkCount(bookRoot: string, chapters: number[]): number
  cleanupRagAfterMerge(bookRoot: string, sourceChapterNos: number[], targetChapterNo: number): void
}

// ── 内部工具 ─────────────────────────────────────────────────────────

export const BODY_PREFIX = '写作/正文/'
export const VERSIONS_DIR_REL = '工作区/.版本'

/** 单读派生：章文件盘上状态（字节 → revision / UTF-8 判定 / fm+正文 三路同源，
 *  /消除重复整读与读间 TOCTOU 的同款口径）。 */
export interface ChapterDiskState {
  path: string
  abs: string
  bytes: Buffer
  rev: `sha256:${string}`
  text: string
  fmRaw: string
  body: string
  map: Map<string, unknown>
  章号: number
  标题: string
  序?: number
  并入: number[]
}

export function fail(code: string, reason: string): StructureFailure {
  return { ok: false, code, reason }
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 读章文件盘上状态；未登记/非正文章/fm 坏 → 结构化失败。 */
export async function readChapterState(
  svc: DocumentService,
  bookRoot: string,
  docId: string,
): Promise<ChapterDiskState | StructureFailure> {
  const path = await svc.resolvePathAsync(docId)
  if (!path) return fail('NOT_FOUND', `文档ID未在清单登记：${docId}`)
  if (!path.startsWith(BODY_PREFIX)) return fail('BAD_INPUT', `目标不是正文区章文件：${path}`)
  if (layoutOf(path).role !== 'chapter') return fail('BAD_INPUT', `目标不是章文档：${path}`)
  // -源码：清单路径可篡改数据面 defense-in-depth——resolvePathAsync 产出的
  // path 裸 join 前经 safeManifestPath 收口（越界/非法 → BAD_INPUT 拒收，不留书外探测面）
  const abs = safeManifestPath(bookRoot, path)
  if (!abs) return fail('BAD_INPUT', `清单路径越界或非法：${path}`)
  if (!existsSync(abs)) return fail('NOT_FOUND', `源文件不存在：${path}`)
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (e) {
    return fail('WRITE_ERROR', `读 ${path} 失败：${errMsg(e)}`)
  }
  const rev = `sha256:${sha256Hex(bytes)}` as `sha256:${string}`
  const text = bytes.toString('utf-8')
  const split = splitFrontMatter(text)
  if (!split) return fail('BAD_INPUT', `${path} 无 frontmatter 或未闭合（章文件须带 fm）`)
  const map = parseFlat(split.fmRaw)
  const no = Number(map.get('章号'))
  if (!Number.isInteger(no) || no < 1) return fail('BAD_INPUT', `${path} fm 章号缺失或非法`)
  const state: ChapterDiskState = {
    path,
    abs,
    bytes,
    rev,
    text,
    fmRaw: split.fmRaw,
    body: split.body,
    map,
    章号: no,
    标题: typeof map.get('标题') === 'string' ? (map.get('标题') as string) : '',
    并入: parseMergedInto(map.get('并入')) ?? [],
  }
  const order = parseOrderOf(map.get('序'))
  if (order !== undefined) state.序 = order
  return state
}

/** plan 指纹：参数 + 双方 fm/正文哈希——apply 复核防 TOCTOU（干跑确认窗口内世界已变即拒）。 */
export function mergePlanHash(target: ChapterDiskState, source: ChapterDiskState, mergedInto: number[]): string {
  return sha256Hex(JSON.stringify({ op: 'merge', t: target.path, s: source.path, tr: target.rev, sr: source.rev, m: mergedInto }))
}

export function splitPlanHash(o: ChapterDiskState, cursorOffset: number, newChapterNo: number, order: number): string {
  return sha256Hex(JSON.stringify({ op: 'split', p: o.path, r: o.rev, c: cursorOffset, n: newChapterNo, o: order }))
}

/** 合并折叠：目标既有 并入 ∪ {源章号} ∪ 源自身 并入（链式单跳化），排序去重。 */
export function foldMergedInto(target: ChapterDiskState, source: ChapterDiskState): number[] {
  return [...new Set([...target.并入, source.章号, ...source.并入])].sort((a, b) => a - b)
}

/** 拼接规范形（§三.11）：canonicalize(目标正文) + 空行分隔 + canonicalize(源正文)
 *  ——与 save 链规范形一致，避免拼接缝产生机检伪红。 */
export function concatChapterBody(target: ChapterDiskState, source: ChapterDiskState): string {
  return `${canonicalizeText(target.body).trimEnd()}\n\n${canonicalizeText(source.body).trimStart()}`
}

/** 正文起始偏移（splitFrontMatter 同款 fence 判定；无 fm → 0）。 */
export function bodyStartOffset(text: string): number {
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i]!)) return lines.slice(0, i + 1).join('\n').length + 1
  }
  return 0
}

/** 事件副录（审计层）：写失败 warn 不阻断主流程（文件本位——盘上状态是权威）。 */
export async function recordStructureEvents(userDataPath: string | null, bookRoot: string, events: NewEvent[]): Promise<void> {
  if (!userDataPath || events.length === 0) return
  let store: SessionStore | null = null
  try {
    store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      store.appendEvents(sessionId, events)
    } finally {
      store.close()
    }
  } catch (e) {
    log.warn('structure', `结构操作事件副录失败（${events.map((e2) => e2.type).join(',')}，审计链缺段；盘上状态不受影响）：${errMsg(e)}`)
  }
}

/** 全书已用最大章号：正文区文件名章号 + 并入 在档源章号（合并产生的洞也是「已用」，
 *  新章号永不回头填洞——留洞制）。 */
export function maxUsedChapter(bookRoot: string): number {
  let max = 0
  const bodyDir = join(bookRoot, BODY_PREFIX)
  if (existsSync(bodyDir)) {
    walkMdEach(bodyDir, (_fp, name) => {
      const n = chapterNoFromName(name)
      if (n !== null && n > max) max = n
    })
  }
  for (const src of mergedIntoMap(bookRoot).keys()) {
    if (src > max) max = src
  }
  return max
}

// ── B004（0918三拍板批）：章号双轨一致性闸 ─────────────────────────────

/** 章号失配条目：文件名前缀号（正轨）vs fm 章号。fmNo=null = fm 章号缺失/非法/不可读。 */
export interface ChapterNoMismatch {
  path: string
  nameNo: number
  fmNo: number | null
}

/** B004：全书 fm 章号 ≡ 文件名前缀章号 对账。背景：两轨口径混用——取号
 *  （maxUsedChapter）/违规检测（detectStructureViolations）/定稿集合
 *  （finalizedChapterNumbers）全按文件名号派生，fm 号只服务被操作章
 *  （readChapterState）——作者外部改名后两轨失配，并入 登记/违规检测/取号互相
 *  矛盾（静默重号/错定位）。只扫具名章号的 .md（无号名另有命名规范检测面）；
 *  fm 缺失/非法也计失配（fail-closed：带着未知盘面取号比拒绝执行更贵）。读侧
 *  走 readMdTextCached 指纹缓存（与 splitOrderMid 同款）；读失败（null）计失配。 */
export function chapterNumberMismatches(bookRoot: string): ChapterNoMismatch[] {
  const out: ChapterNoMismatch[] = []
  const bodyDir = join(bookRoot, BODY_PREFIX)
  if (!existsSync(bodyDir)) return out
  walkMdEach(bodyDir, (fp, name) => {
    const nameNo = chapterNoFromName(name)
    if (nameNo === null) return
    const rel = relative(bookRoot, fp).replaceAll('\\', '/')
    const raw = readMdTextCached(fp)
    if (raw === null) {
      out.push({ path: rel, nameNo, fmNo: null })
      return
    }
    const sp = splitFrontMatter(raw)
    if (!sp) {
      out.push({ path: rel, nameNo, fmNo: null })
      return
    }
    const no = Number(parseFlat(sp.fmRaw).get('章号'))
    if (!Number.isInteger(no) || no < 1 || no !== nameNo) {
      out.push({ path: rel, nameNo, fmNo: Number.isInteger(no) && no >= 1 ? no : null })
    }
  })
  return out
}

/** B004：结构操作入口一致性闸——失配 fail-loud（CHAPTER_NO_MISMATCH → HTTP 409）。
 *  结构操作（拆分/合并/撤销）带着失配盘面执行会放大重号/错定位，先拒后做；报文
 *  指明修复方向：文件名号为正，改 fm 对齐（或把文件名改回）。最多列 5 处 + 总数。
 *  拍板注：fail-loud 会拦存量失配书的一切结构操作（须先修书）——作者拍板接受
 *  （真开放待拍板 2 之 B004）。
 *  只拦「fm 存在且 ≠ 文件名号」的真失配；fm 缺失/无 frontmatter 不拦——三个取号
 *  消费者全按文件名号派生（fm 缺失文件照常占号，保守无险），被操作章自身有
 *  readChapterState 的 BAD_INPUT 兜底，且杂散占位文件（B105 还原失败半完成态的
 *  典型盘面）不得堵死「重试自动续跑收尾」恢复路径。 */
export function chapterNoMismatchFailure(bookRoot: string): StructureFailure | null {
  const mismatches = chapterNumberMismatches(bookRoot).filter((m) => m.fmNo !== null)
  if (mismatches.length === 0) return null
  const shown = mismatches
    .slice(0, 5)
    .map((m) => `《${m.path}》文件名 ${m.nameNo} / fm ${m.fmNo}`)
    .join('；')
  const more = mismatches.length > 5 ? `等共 ${mismatches.length} 处` : ''
  return fail(
    'CHAPTER_NO_MISMATCH',
    `章号失配：${shown}${more}。文件名号为正（取号/并入登记/违规检测均按文件名前缀），请把 fm「章号」改为与文件名一致（或把文件名改回）后重试。`,
  )
}

/** 已定稿章号集合（manifest finalizedRevision 条目，路径章号派生；state.ts
 *  skipFinalizedChapters 同语义）。strict 读失败上抛——取号错比拒绝执行更贵
 *  （fail-closed；异常穿透 apply 锁释放后由 server 路由顶层兜底 500 ERROR、
 *  message 脱敏——RC 全项目修注：原注「调用方收 WRITE_ERROR 信封」
 *  与实际路由不符，如需信封化须在 plan/apply 入口显式收口，此处按实况记档）。
 *  0918修复批（B005 尾项）：章号提取剥 .md 茎后判定（isMdFileName 单源 +
 *  chapterNoFromName）——裸数字定稿条目（0012.md）此前带扩展直判失明，skipFinalized
 *  漏跳 → 拆分取号可撞定稿章号。
 *  0918二轮修复批（B102）：isSafeInteger 手工守卫删除——守卫已下沉
 *  chapterNoFromName 单源（16+ 位失真大数恒 null），与 manifest.ts 同名函数对齐。 */
export function finalizedChapterNumbers(bookRoot: string): Set<number> {
  const out = new Set<number>()
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return out
  const m = readManifestStrict(manifestPath)
  for (const e of m.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    const base = basename(e.path)
    const n = chapterNoFromName(isMdFileName(base) ? base.slice(0, -3) : base)
    if (n !== null) out.add(n)
  }
  return out
}

/** n 起步跳过一切已定稿章号（「篇号永不复用」语义；连续定稿时 n+1 即空闲）。 */
export function skipFinalized(n: number, finalized: Set<number>): number {
  let next = n
  while (finalized.has(next)) next++
  return next
}

/** 新章显示序：拆分点两侧有效序中值——原章有效序与其在显示序中后继章有效序的中点；
 *  原章是显示序末章时 +0.5（严格大于原章、小于任何后续追加章的缺省序）。 */
export function splitOrderMid(bookRoot: string, origin: ChapterDiskState): number {
  const selfOrder = origin.序 ?? origin.章号
  const selfReal = realpathOf(origin.abs)
  let next = Infinity
  const bodyDir = join(bookRoot, BODY_PREFIX)
  if (existsSync(bodyDir)) {
    // 与 tree.ts sortTreeByOrder 同口径：序 ?? 文件名章号（readMdTextCached 复用指纹缓存）
    walkMdEach(bodyDir, (fp, name) => {
      if (realpathOf(fp) === selfReal) return
      const n = chapterNoFromName(name)
      if (n === null) return
      let ord: number = n
      const raw = readMdTextCached(fp)
      const sp = raw === null ? null : splitFrontMatter(raw)
      if (sp) {
        const om = parseOrderOf(parseFlat(sp.fmRaw).get('序'))
        if (om !== undefined) ord = om
      }
      if (ord > selfOrder && ord < next) next = ord
    })
  }
  return next === Infinity ? selfOrder + 0.5 : (selfOrder + next) / 2
}

function realpathOf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 版本推演：目标章最新一个「fm 并入 不含源章号」的版本 id（崩溃续跑 / 降级 undo
 *  定位 rollbackSnapshotId 用——正常路径由 save 前后版本集差分得出，此为世界已变
 *  或事件缺失时的兜底；推演自带「并入 不含源」校验，天然排除合并后版本）。 */
export function newestVersionWithoutSource(bookRoot: string, docId: string, sourceChapterNo: number): string | null {
  const versionsDir = join(bookRoot, VERSIONS_DIR_REL)
  for (const v of listVersions(versionsDir, docId)) {
    const snap = readVersion(versionsDir, docId, v.id)
    if (!snap) continue
    const sp = splitFrontMatter(snap.content)
    if (!sp) return v.id // 无 fm 的更旧形态必在并入 机制之前
    const merged = parseMergedInto(parseFlat(sp.fmRaw).get('并入')) ?? []
    if (!merged.includes(sourceChapterNo)) return v.id
  }
  return null
}
