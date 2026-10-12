/**
 * 写作技巧包 skill 化（批次）。
 *
 * 多根发现 + 按需加载（对齐 spill 的预算纪律：system prompt 不背全量正文）：
 * - 三根扫描，rank 高覆盖低（同名去重）：项目 <bookRoot>/设定/技巧/*.md
 *   → 用户 <userDataPath>/skills/*.md → 捆绑 resources/skills/*.md；
 * - 索引（formatSkillIndex）只暴露元信息（一行一包），正文由 read_skill 工具
 *   按名取用（loadSkill）——模型看到目录，用到哪包读哪包。
 *
 * 容错约定：目录缺失/读失败一律 best-effort 跳过——技巧包残缺绝不阻断对话。
 * frontmatter 复用 format/frontmatter 的 readFile/parseFlat（平铺 key: value）。
 */
import { join, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { isMdFileName } from '../format/filename.js'
import { readKind } from '../format/kind.js'
import { bundledResource } from '../fs/resources.js'
import { statFingerprint } from '../fs/hash.js' // stat 指纹单源
import { resolveCorpusFile } from '../knowledge/corpus.js'
import { titleOf } from '../knowledge/inject.js'
import { registerKindOfCategory } from '../knowledge/catalog.js'
import { log, errMsg } from '../log/index.js'

// ── 技巧包文件级 mtime 缓存 ────────────────────────
// listSkills 此前三根全量 readFileSync+parse（chat 每轮组 system prompt 索引都扫），
// loadSkill 又经由 listSkills 只为按名找一条、找到后再 readFileSync 重读一遍正文。
// 每文件 (mtimeNs,size) 指纹 → 已解析条目（meta + 剥 fm 正文）：指纹命中免读免解析，
// 文件任何改写（指纹必变）即时失效，无需 TTL（setting-rule 同思路、更细粒度）。
// 读失败不缓存（「不可读不入索引」口径保持）；命中返回 meta 浅拷贝（调用方
// 改字段不污染缓存）。FIFO 上限防用户库增长无界缓涨（chapters.ts chapterDirCache
// 同款纪律；技能包个位数、上限只兜异常形态）。
interface SkillFileEntry {
  sig: string
  meta: SkillMeta
  content: string
}
const SKILL_FILE_CACHE_MAX = 256
const skillFileCache = new Map<string, SkillFileEntry>()

/** 单文件 (mtimeNs,size) 指纹（stat 失败 = null，调用方按未缓存处理，下轮重试）。
 *  串形走 fs/hash.statFingerprint 单源（原本地为逗号分隔——纯进程内 Map 键，
 *  收敛后统一冒号，仅在升级当次致一次冷读，行为等价）。 */
function skillFileSig(fp: string): string | null {
  try {
    const st = statSync(fp, { bigint: true })
    return statFingerprint(st)
  } catch {
    return null
  }
}

/** 技巧包元信息（索引级；正文按需加载） */
export interface SkillMeta {
  name: string
  description: string
  whenToUse: string
  /** 机器判据（可选；缺省 = 该面该档全投放） */
  when?: SkillWhen
  /** 引用语料篇目（单向：作业包 → 知识层；正文按需附于包正文后） */
  references?: string[]
  source: 'bundled' | 'user' | 'project'
  path: string
}

/** 作业包唯一的现行消费面（写稿/三审面未接作业包） */
export const SKILL_FACE_CHAT = 'chat'

/** 作业包投放判据（`when_face` / `when_kinds`；声明即事实，非自由文本） */
export interface SkillWhen {
  /** 投放面；缺省 = 不限面。按字面与消费面比较（写错面名 = 不投放 + warn 留痕） */
  face?: string
  /** 适用书档位；缺省 = 不限档 */
  kinds?: ('long' | 'short')[]
}

/** 投放上下文 = 判据的机算事实（消费面 + 本书档位） */
export interface SkillDispatchContext {
  face: string
  kind: 'long' | 'short'
}

/** 多根发现入参（均可缺省——缺省的根直接跳过） */
interface SkillRoots {
  bookRoot?: string
  userDataPath?: string
}

/** 作业包 front matter 的判据键（受限解析子集：平铺键 + 内联数组，嵌套块不入子集） */
const FM_KEY_WHEN_FACE = 'when_face'
const FM_KEY_WHEN_KINDS = 'when_kinds'
const FM_KEY_REFERENCES = 'references'

/** 档位名白名单（与 `BookConfig.kind` 同域；越界项丢弃并 warn） */
const SKILL_KINDS: readonly ('long' | 'short')[] = ['long', 'short']

/** fm 平铺值取标量文本：只认 string/number/boolean（`isFmWritableValue` 的标量族）；
 *  数组/对象等复合值不降级成 '"a,b"' / '"[object Object]"' 这类伪值入索引——取 `fallback`。
 *  形态（`name: [a, b]`）本就不是本字段的合法值，静默拼出怪名比回落更难查。 */
function fmScalarOf(map: Map<string, unknown>, key: string, fallback: string): string {
  const v = map.get(key)
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

/** `when` 判据解析：两键皆缺 → undefined（不限）。 */
function parseWhen(map: Map<string, unknown>, fp: string): SkillWhen | undefined {
  const face = fmScalarOf(map, FM_KEY_WHEN_FACE, '')
  const kindsRaw = map.get(FM_KEY_WHEN_KINDS)
  const items = Array.isArray(kindsRaw) ? kindsRaw : kindsRaw === undefined ? [] : [kindsRaw]
  const kinds = items.flatMap((v): ('long' | 'short')[] => {
    const s = typeof v === 'string' ? v.trim() : ''
    return (SKILL_KINDS as readonly string[]).includes(s) ? [s as 'long' | 'short'] : []
  })
  if (kinds.length < items.length) {
    // 写了但不生效须留痕（与 frontmatter 残行同款纪律）：档位名写错时包会在该档静默消失
    log.warn('skills', `技巧包 when_kinds 含不识别档位名已忽略（保留 ${kinds.length}/${items.length} 项）：${fp}`)
  }
  if (face !== '' && face !== SKILL_FACE_CHAT) {
    log.warn('skills', `技巧包 when_face 非现行消费面（唯一消费面 = ${SKILL_FACE_CHAT}），该包不投放：${fp}`)
  }
  if (face === '' && kinds.length === 0) return undefined
  return { ...(face !== '' ? { face } : {}), ...(kinds.length > 0 ? { kinds } : {}) }
}

/** `references` 解析：标量按单篇、数组按序；去空项与重复项，声明序即注入序。
 *  导出供 CI 门复用——门与运行时对「什么算声明了一篇」须是同一判据。 */
export function parseReferences(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of Array.isArray(raw) ? raw : [raw]) {
    const rel = String(v).trim()
    if (rel === '' || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out.length > 0 ? out : undefined
}

/** 扫描单个根目录 → 元信息列表（目录缺失/读失败 → 空数组，best-effort） */
function scanRoot(dir: string, source: SkillMeta['source']): SkillMeta[] {
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    // 过滤口径同 readCharacterCards：只收 .md，跳过 macOS 资源叉 ._*
    // .md 判定收敛 isMdFileName（大小写不敏感家族）——
    // .MD 技巧包不入索引（模型看不到目录即无从 read_skill 取用）
    files = readdirSync(dir).filter((f) => isMdFileName(f) && !f.startsWith('._'))
  } catch {
    return []
  }
  const out: SkillMeta[] = []
  for (const f of files) {
    const fp = join(dir, f)
    // 指纹命中 → 免读免解析（一次 stat 换 readFileSync+parse；stat 失败按
    // 未缓存处理走现读，读失败会 warn 跳过——不缓存失败，下轮重试）
    const sig = skillFileSig(fp)
    if (sig !== null) {
      const hit = skillFileCache.get(fp)
      if (hit && hit.sig === sig) {
        out.push({ ...hit.meta })
        continue
      }
    }
    // 索引先试读——readFile 的 {ok:false} 混装「读失败」与
    // 「无 front matter」两种形态，此前一律按裸 md 降级收录：不可读文件（权限/竞态
    // 删除/IO 故障）也进索引，而 loadSkill 对它恒 null——模型见目录取不到包。现读
    // 失败不入索引并 warn 留痕（读到 text 后再走 readFile 的 content 参数，不二读）
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch (e) {
      log.warn('skills', `技巧包读取失败，不入索引：${fp}（${errMsg(e)}）`)
      continue
    }
    const r = readFile(fp, text)
    if (r.ok) {
      const map = parseFlat(r.fmRaw)
      const when = parseWhen(map, fp)
      const references = parseReferences(map.get(FM_KEY_REFERENCES))
      out.push({
        name: fmScalarOf(map, 'name', basename(f, '.md')),
        description: fmScalarOf(map, 'description', ''),
        whenToUse: fmScalarOf(map, 'whenToUse', ''),
        ...(when !== undefined ? { when } : {}),
        ...(references !== undefined ? { references } : {}),
        source,
        path: fp,
      })
    } else {
      // 无 front matter 降级（用户随手丢的裸 md）：name=文件名，全文即正文，不拒之门外
      out.push({ name: basename(f, '.md'), description: '', whenToUse: '', source, path: fp })
    }
    // 读成功才入缓存（meta 存独立副本，返回值与缓存不共享引用；content 与
    // loadSkill 的剥 fm 口径一致：有 fm 取 body.trim，裸 md 取全文 trim）
    if (sig !== null) {
      const meta = out[out.length - 1]!
      if (skillFileCache.size >= SKILL_FILE_CACHE_MAX) {
        const oldest = skillFileCache.keys().next().value
        if (oldest !== undefined) skillFileCache.delete(oldest)
      }
      skillFileCache.set(fp, { sig, meta: { ...meta }, content: r.ok ? r.body.trim() : text.trim() })
    }
  }
  return out
}

/**
 * 三根发现技巧包元信息（rank：项目 > 用户 > 捆绑，同名高 rank 覆盖低 rank）。
 * 输出按 name 排序——索引展示与测试断言都稳定。
 */
export function listSkills(roots: SkillRoots): SkillMeta[] {
  const byName = new Map<string, SkillMeta>()
  // 低 rank 先入、高 rank 后入：Map.set 同 key 覆写即覆盖语义
  for (const meta of scanRoot(bundledResource('skills'), 'bundled')) byName.set(meta.name, meta)
  if (roots.userDataPath) {
    for (const meta of scanRoot(join(roots.userDataPath, 'skills'), 'user')) byName.set(meta.name, meta)
  }
  if (roots.bookRoot) {
    for (const meta of scanRoot(join(roots.bookRoot, '设定', '技巧'), 'project')) byName.set(meta.name, meta)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 判据命中（`when` 缺省 = 不限；两键都写上则须同时命中）。
 *
 * 面判据按**字面**比较，不做「未声明面 = 全投放」的宽容：作业包判据写错面名时模型看到
 * 索引却取不到正文，非必要的失配；解析侧已对非现行面名 warn 留痕（唯一消费面 = chat）。
 */
export function skillDispatchOK(meta: SkillMeta, ctx: SkillDispatchContext): boolean {
  const when = meta.when
  if (!when) return true
  if (when.face !== undefined && when.face !== ctx.face) return false
  if (when.kinds !== undefined && !when.kinds.includes(ctx.kind)) return false
  return true
}

/**
 * 按判据过滤索引（投放面单源：`buildChatContext` 组装索引与 `read_skill` 取正文同过此处，
 * 两侧判据不得各写一份——分叉即「索引里有、取不到」或反向）。
 */
export function listDispatchableSkills(roots: SkillRoots, ctx: SkillDispatchContext): SkillMeta[] {
  return listSkills(roots).filter((m) => skillDispatchOK(m, ctx))
}

/**
 * 本书档位（作业包判据与引用篇按档解析的共同入参）。
 * `bookRoot` 缺省（无书上下文的长目录快照）→ long：与 `readKind` 的读不到即 long 同径。
 */
export function bookKindFor(bookRoot: string | undefined): 'long' | 'short' {
  return bookRoot ? readKind(bookRoot) : 'long'
}

/** 索引渲染用的投放上下文（无书 = 无档位事实，取 long 档；索引面为长目录快照） */
function dispatchContextOf(roots: SkillRoots): SkillDispatchContext {
  return { face: SKILL_FACE_CHAT, kind: bookKindFor(roots.bookRoot) }
}

// ── roots 级 name→meta 索引缓存 ──────────────
// loadSkill 原每次都调 listSkills(roots) 全量扫三根（逐文件 readdir + stat）只为按名
// 取一条，命中后再 stat 目标文件复核指纹——read_skill 每次调用 O(总技巧包数) 系统调用。
// 现按 roots 指纹（三根目录 mtimeNs：新增/删除/改名会使目录 mtime 变化）缓存 name→meta
// 索引：指纹命中即为 O(1) 查询 + 目标文件一次指纹校验。索引未命中或目标文件被改动
// （name/whenToUse/正文可能陈旧）时整体重建一次，覆盖改名/新增/内容改写形态，语义与
// 逐次全量扫描一致。残留窗口：仅「另一根某包就地改名，恰使同名归属易主、且目标文件
// 自身未动」的极窄形态，在目标文件下一次改动或目录增删前不感知；目录增删即失效。
// FIFO 上限防书库增多无界缓涨（同 skillFileCache 纪律）。
interface SkillIndexEntry {
  sig: string
  index: Map<string, SkillMeta>
}
const SKILL_INDEX_CACHE_MAX = 64
const skillIndexCache = new Map<string, SkillIndexEntry>()

/** 单目录 mtimeNs 指纹（stat 失败 = '-'，按未缓存处理）。 */
function dirSig(dir: string): string {
  try {
    const st = statSync(dir, { bigint: true })
    return `${st.mtimeNs}`
  } catch {
    return '-'
  }
}

/** roots 指纹：三根目录 mtimeNs 有序拼接（bundled 恒在，user/project 缺省用 '-'）。 */
function skillRootsSig(roots: SkillRoots): string {
  return [
    dirSig(bundledResource('skills')),
    roots.userDataPath ? dirSig(join(roots.userDataPath, 'skills')) : '-',
    roots.bookRoot ? dirSig(join(roots.bookRoot, '设定', '技巧')) : '-',
  ].join('|')
}

function skillIndexKey(roots: SkillRoots): string {
  return `${roots.bookRoot ?? ''}\u0000${roots.userDataPath ?? ''}`
}

/** 取 roots 对应 name→meta 索引；force 或指纹失配即重建。cached 标记是否命中原缓存。 */
function skillIndexFor(roots: SkillRoots, force = false): { index: Map<string, SkillMeta>; cached: boolean } {
  const key = skillIndexKey(roots)
  const sig = skillRootsSig(roots)
  const hit = skillIndexCache.get(key)
  if (!force && hit && hit.sig === sig) return { index: hit.index, cached: true }
  const index = new Map(listSkills(roots).map((m) => [m.name, m]))
  if (skillIndexCache.size >= SKILL_INDEX_CACHE_MAX) {
    const oldest = skillIndexCache.keys().next().value
    if (oldest !== undefined) skillIndexCache.delete(oldest)
  }
  skillIndexCache.set(key, { sig, index })
  return { index, cached: false }
}

/**
 * 取包正文本体（不含引用篇与判据过滤——公开入口 `loadSkill` 在其上补这两层）。
 * 名字未知/文件读失败 → null（调用方据此回「未找到 + 可用列表」）。
 * 查名走 roots 级索引缓存（见上方注释），不再每次全量扫三根。
 */
function loadSkillContent(name: string, roots: SkillRoots): { meta: SkillMeta; content: string } | null {
  let lookup = skillIndexFor(roots)
  let meta = lookup.index.get(name)
  // 未命中且来自缓存 → 可能新增/改名的包：强制重建一次再查（语义同全量扫描）
  if (!meta && lookup.cached) {
    lookup = skillIndexFor(roots, true)
    meta = lookup.index.get(name)
  }
  if (!meta) return null
  // 正文直查文件级缓存（读前重验指纹——listSkills 建索引与 read_skill 取
  // 正文之间可能隔整轮对话，作者中途改包须取到新文；指纹失配/竞态删除落回现读）
  let sig = skillFileSig(meta.path)
  let hit = sig !== null ? skillFileCache.get(meta.path) : undefined
  if (hit && hit.sig === sig) return { meta, content: hit.content }
  // 目标文件指纹失配：索引 meta 可能陈旧（name/whenToUse 被改）→ 重建一次取新 meta
  if (lookup.cached) {
    lookup = skillIndexFor(roots, true)
    meta = lookup.index.get(name)
    if (!meta) return null
    sig = skillFileSig(meta.path)
    hit = sig !== null ? skillFileCache.get(meta.path) : undefined
    if (hit && hit.sig === sig) return { meta, content: hit.content }
  }
  const r = readFile(meta.path)
  if (r.ok) return { meta, content: r.body.trim() }
  // 裸 md（无 front matter）：全文即正文（与 scanRoot 降级口径一致）
  try {
    return { meta, content: readFileSync(meta.path, 'utf8').trim() }
  } catch {
    return null
  }
}

// ── 引用篇目（作业包 → 知识层，单向）──────────────
// 作业包正文留操作清单，可复用的判断类知识不重抄一份，改 `references` 指语料篇：
// 语料本体单源在 知识层/（书级可覆盖），作业包只声明引用关系。
// 模型无通用读文件工具（chat 工具面只有 read_chapter/read_skill 等），解析必须由代码做。
const REFERENCE_HEADING = '## 引用篇目（来自本书知识层）\n'

/**
 * 按书档过滤引用篇目：档位专属类目（`长篇`/`短篇`）只对本档书生效，`通用` 等跨档类目
 * 两档共用。判据单源在 catalog 的 `registerKindOfCategory`（类目轴改名时各面不各写一份）。
 *
 * 作业包据此可同时声明两档的引用篇（如「黄金三章」引 `长篇/开篇设计速查.md` +
 * `短篇/章节钩子速查.md`），取用时只嵌本书本档的那些——引用篇本身即分档语料。
 */
export function referencesForKind(rels: readonly string[], kind: 'long' | 'short'): string[] {
  return rels.filter((rel) => {
    const reg = registerKindOfCategory(rel.split('/')[0] ?? '')
    return reg === undefined || reg === kind
  })
}

/**
 * 逐 rel 解析（书级 > 随包，单源 `resolveCorpusFile`）并拼引用段。
 * 标题形态与三面注入同源（`titleOf` 单点）；缺件跳过留痕——引用篇是增强面，不阻断取包。
 * 篇内 front matter 不进结果（与三面注入口径一致：署名信息随语料本体留存，不进 prompt）。
 */
function composeReferences(rels: readonly string[], bookRoot: string | undefined): string | null {
  const blocks: string[] = []
  for (const rel of rels) {
    const resolved = resolveCorpusFile(bookRoot, rel)
    if (resolved === null) {
      log.warn('skills', `作业包引用篇两级皆缺，跳过该篇：${rel}`)
      continue
    }
    blocks.push(`### ${titleOf(rel)}\n${resolved.body}`)
  }
  return blocks.length > 0 ? `${REFERENCE_HEADING}${blocks.join('\n\n')}` : null
}

/**
 * 取作业包全文（read_skill 工具的执行通道）：包正文 + 按本书档解析的引用篇。
 *
 * 判据与索引同源（`skillDispatchOK` + `dispatchContextOf`）：按判据不投放的包，此处同样
 * 取不到——索引可见性与取用面分叉会造出「索引里有、读了说没有」的失配。
 * 引用篇缺失/全被档位过滤 → 只回包正文（引用是增强，不是取包前置）。
 *
 * 体量帽不在此层重复：read_skill 的 `READ_SKILL_MAX_CHARS` 作用在返回的全文上，
 * 包正文与引用篇同受一帽（截断通知亦按同一量报告）。
 */
export function loadSkill(name: string, roots: SkillRoots): { meta: SkillMeta; content: string } | null {
  const r = loadSkillContent(name, roots)
  if (!r) return null
  const ctx = dispatchContextOf(roots)
  if (!skillDispatchOK(r.meta, ctx)) return null
  const refs = r.meta.references ? referencesForKind(r.meta.references, ctx.kind) : []
  if (refs.length === 0) return r
  const section = composeReferences(refs, roots.bookRoot)
  if (section === null) return r
  return { meta: r.meta, content: `${r.content}\n\n${section}` }
}

/** 索引默认预算（code points，非 UTF-16 单元——emoji 按 1 计） */
const DEFAULT_INDEX_MAX_CHARS = 800

/**
 * 元信息列表 → system prompt 索引段：头行 + 一行一包（- <name>：<whenToUse>）。
 *
 * 判据字段（`when` / `references`）不进索引行——索引面是「名 + 何时用」的两列，
 * 展判据会顶掉索引预算而不增加模型可用信息（判据已由投放过滤在入口兑现）。
 *
 * 预算纪律：超预算整行丢弃（不切半行），末尾补截断通知行；
 * 通知行自身也计价——装不下则回退再丢整行；头行是地板（只剩头行时破例保留
 * 通知，属配置错误场景的 best-effort）。空列表返回空串（不注入段）。
 */
export function formatSkillIndex(metas: SkillMeta[], opts?: { maxChars?: number }): string {
  if (metas.length === 0) return ''
  const maxChars = opts?.maxChars ?? DEFAULT_INDEX_MAX_CHARS
  const header = '## 写作技巧包（需要时调用 read_skill 工具按名取全文）'
  const lines: string[] = [header]
  let used = Array.from(header).length
  let truncated = false
  for (const m of metas) {
    const line = `- ${m.name}：${m.whenToUse}`
    const cost = 1 + Array.from(line).length // 前置换行 + 本行
    if (used + cost > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    used += cost
  }
  if (truncated) {
    const note = '（技巧包索引超长已截断）'
    while (lines.length > 1 && used + 1 + Array.from(note).length > maxChars) {
      const dropped = lines.pop()!
      used -= 1 + Array.from(dropped).length
    }
    lines.push(note)
  }
  return lines.join('\n')
}
