/**
 * 草稿落盘 + 写稿 prompt（P1-8 架构下沉：从 studio/server/api/draft 下沉内核）。
 *
 * AI 编排层（self-heal）与 draft 落盘端点共用：
 * - saveDraft：覆写留底 → mkdir → 写盘 → 失效树缓存 → docId 反查 → AI 改稿轨迹
 * - buildDraftPrompt：细纲 + 备料 + 章纲 + 设定预算注入（C3：世界观/角色/境界共享
 *   SETTINGS_BUDGET_CHARS，超限先丢宽泛层再截断最具体层）+ 要求（长短篇 front matter 分支）
 */
import { join, basename, dirname, relative, isAbsolute } from 'node:path'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { readChapterDir } from '../format/chapters.js'
import { countWords } from '../format/words.js'
import { bodyOf, parseFlat, readFile } from '../format/frontmatter.js'
import { resolveDraftPath } from '../format/draft.js'
import { readKind } from '../format/kind.js'
import { buildSettingsLayers } from './settings-context.js'
import { assembleSettingsInjection, type SettingsLayer } from './settings-injection.js'
import { pickStyleSamplesWithSources } from './style-samples.js'
import type { BookConfig } from '../format/types.js'
import { readManifest, type Manifest } from '../document/manifest.js'
import { readTrashManifest } from '../document/trash.js'
import { writeSnapshot } from '../document/snapshot.js'
import { legacyId } from '../document/stable-id.js'
import { invalidateTreeIndex } from '../document/tree.js'

/**
 * 覆写留底：已有文件且内容不同 → force 快照（作者手改不静默丢失）。
 * Y-3（第五十七轮）：留底失败（可读但读不进 / 快照写失败等 IO 类）**上抛拒绝覆写**——
 * 此前降级 return null 后 saveDraft 照常覆写，M1「作者手改不静默丢失」在 IO 抖动
 * （跨进程 rename 撞窗 / win AV 短暂锁）下失守。null 仅保留「无需留底」两态：
 * 文件不存在 / 内容相同。
 */
export function snapshotBeforeOverwrite(
  bookRoot: string,
  relPath: string,
  newContent: string,
  origin = 'draft-overwrite',
  manifest?: Manifest,
): string | null {
  const absPath = join(bookRoot, relPath)
  if (!existsSync(absPath)) return null
  const old = readFileSync(absPath, 'utf8')
  if (old === newContent) return null
  // docId：清单反查（编辑器保存的快照同目录）→ 未登记按文件名派生
  let docId: string | undefined
  const m = manifest ?? readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  for (const e of m.entries.values()) {
    if (e.path === relPath) {
      docId = e.id
      break
    }
  }
  if (!docId) docId = legacyId(relPath) // X-P2-2：与树扫盘/编辑器 openTab 同口径（basename 派生会造出第二身份）
  return writeSnapshot(join(bookRoot, '工作区', '.版本'), docId, old, { origin }, { force: true })
}

/**
 * 草稿落盘全套副作用（/draft-save 端点与全自动写章闭环 self-heal.ts 共用）：
 * 覆写留底 → mkdir → 写盘 → 失效树缓存 → docId 反查。
 *
 * 文风改稿轨迹（recordAuthorSignal + recordAiVersion）由调用方在落盘后显式调用，
 * 避免 process/ → ai/ 的向上依赖（P1-ARCH-1 循环依赖修复）。
 * 落盘失败向上抛，调用方决定回应。
 */
export function saveDraft(
  bookRoot: string,
  chapter: number,
  content: string,
  opts?: { snapshotOrigin?: string },
): { relPath: string; docId: string; words: number; snapshotted: boolean } {
  const { relPath } = resolveDraftPath(bookRoot, chapter, content)
  const absPath = join(bookRoot, relPath)
  // Y-3（第五十七轮）：回收站双认领守卫——目标文件在盘且回收站登记仍认领同一路径
  // （restoreTrash 半途崩溃态：文件已 rename 回原位、trash 条目未清）时，此路径的
  // 归属是歧义的（清单/快照/journal 按 docId 认路径，trash 条目也认它），覆写会加深
  // 错乱——中止上抛交作者先在回收站决断。路径不存在的「删后重写」不拦：那是新文件，
  // 旧内容仍在回收站可还原（故意重写不受阻）。
  if (existsSync(absPath) && readTrashManifest(bookRoot).some((e) => e.originalPath === relPath)) {
    throw new Error(`目标 ${relPath} 同时存在于磁盘与回收站登记（可能是恢复中断的残留），已中止写入——请先在回收站完成还原或清除`)
  }
  // 入口读一次 manifest，传给 snapshotBeforeOverwrite + docId 反查（消除双重读盘）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  // M1 覆写留底：已有文件且内容不同 → force 快照（作者手改不静默丢失）
  const snapshotId = snapshotBeforeOverwrite(bookRoot, relPath, content, opts?.snapshotOrigin, manifest)
  mkdirSync(dirname(absPath), { recursive: true })
  // B-P2-3：fsync 保证草稿落盘不丢字（崩溃/断电场景内容先 fsync 再 rename）
  atomicWriteFile(absPath, content, { fsync: true })
  // 新文件落盘会改变树结构 → 失效树缓存（前端保存后重拉树能看到新草稿）
  invalidateTreeIndex(bookRoot)
  // M3 存草稿并编辑：返回 docId（清单已登记给真 ID；未登记回落 legacyId(relPath)，
  // 与树扫盘一致，前端可直接 openTab）
  let docId: string | null = null
  for (const e of manifest.entries.values()) {
    if (e.path === relPath) {
      docId = e.id
      break
    }
  }
  const finalDocId = docId ?? legacyId(relPath)
  // Q4：剥 fm 后计字数（与保存协议 service.ts 口径一致，fm 键值不入字数）
  const words = countWords(bodyOf(content))
  // 清单检文件链（批 3）：短篇写稿后把 AI 章纲（工作区/细纲.md）同步到大纲/章纲/<正文basename>，
  // 使 清单形式检（runner.ts:158 按正文同名找章纲）+ pieceListChecks 有数据可读。
  // 短篇正文文件名与章纲同 basename 契约：正文 <章号3位>-<标题>.md → 章纲同名。
  syncChapterOutline(bookRoot, relPath)
  return { relPath, docId: finalDocId, words, snapshotted: snapshotId !== null }
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 清单检文件链（批 3）：短篇写稿后同步 AI 章纲。
 *
 * 短篇 清单形式检 按 大纲/章纲/<正文basename> 读章纲（runner.ts:158），
 * 而 outline 端点把章纲写到 工作区/细纲.md（短篇无布线，细纲即章纲）。
 * 写稿落盘（saveDraft，draft-save 端点与 self-heal 共用）后，
 * 若为短篇且 细纲.md 存在 → 复制到 大纲/章纲/<正文basename>，文件名契约对齐。
 *
 * RB-IF-P2-4：仅创建缺失的章纲——已存在且内容与细纲不同视为作者手改，不覆盖
 * （正文覆写有 snapshotBeforeOverwrite 留底，章纲原先是静默覆盖，红线不一致）。
 * 无细纲/非短篇/正文非标准章号 → 跳过（不阻断保存）。
 */
export function syncChapterOutline(bookRoot: string, bodyRelPath: string): boolean {
  if (readKind(bookRoot) !== 'short') return false
  const outlinePath = join(bookRoot, '工作区', '细纲.md')
  if (!existsSync(outlinePath)) return false
  const base = basename(bodyRelPath)
  if (!/^\d{3,}-.+/.test(base)) return false // 非标准 <章号3位>-<标题>.md → 不落章纲
  const outlineContent = readSafe(outlinePath)
  if (!outlineContent) return false
  const target = join(bookRoot, '大纲', '章纲', base)
  if (existsSync(target)) {
    // 已有章纲：内容一致 → no-op；不同 → 作者手改优先，保留不覆盖
    return readSafe(target) === outlineContent
  }
  const outlineDir = join(bookRoot, '大纲', '章纲')
  mkdirSync(outlineDir, { recursive: true })
  atomicWriteFile(join(outlineDir, base), outlineContent)
  return true
}

/** 按章号定位本章章纲文件（大纲/章纲/000N-*.md，fm 章号匹配）——情节依据与场景声明共用 */
function findChapterOutlinePath(bookRoot: string, chapter: number): string | null {
  const { chapters } = readChapterDir(join(bookRoot, '大纲', '章纲'))
  return chapters.find((c) => c.章号 === chapter)?._path ?? null
}

/** 读本章章纲（大纲/章纲/000N-*.md，按章号匹配文件名前缀）——AI 写稿的情节依据；
 *  Q-5 后由 buildDraftPrompt 直接持路径（readSafe + relative 进 files 清单） */

/**
 * front matter「场景」值 → 场景数组（水源①章纲/②正文共用的解析端）。
 * 单值 `场景: 对话` → ['对话']；多值 `[战斗, 对话]` → 数组（首为主场景）；数组项过滤空串再
 * trim。空值/其他类型 → []——空结果表示「该水源未声明」，调用方据此继续回退而非直接落通用。
 */
function scenesOfFmValue(scene: unknown): string[] {
  if (typeof scene === 'string' && scene.trim()) return [scene.trim()]
  if (Array.isArray(scene)) {
    return scene
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())
  }
  return []
}

/**
 * 细纲场景声明段的合法场景枚举（kk-P2：与 outline 端点短篇 prompt 的场景枚举同口径——
 * 「战斗/对话/抒情/叙事铺陈/爽点高潮」。水源③是 AI 按 prompt 产出的段，段内引号项
 * 过滤到枚举内，防 AI 写解释性引号词（如「此处注意」）被当场景串样章；
 * 水源①②的 fm 字段是作者/AI 结构化声明，不过滤（自定义场景样章目录合法）。
 */
const OUTLINE_SCENE_ENUM = new Set(['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'])

/**
 * 细纲正文「## 场景声明」段 → 场景数组（水源③的解析端）。解析规则确定性、不猜格式：
 * 1. 定位段：首个以 `## 场景声明` 开头的标题行（容忍 `##场景声明` 无空格写法），
 *    到下一个 `## ` 标题行前为止——段外的引号词不收，防串段；
 * 2. 段内有「」引号项 → 按出现序全部提取（去重）。outline 短篇 prompt 要求 AI 用「」标出
 *    主场景，这是主路径。如 `本章主场景:「战斗」。` → ['战斗']；
 * 3. 全段无引号 → 找「主场景」行（容忍列表符前缀），取半/全角冒号后 trim 的词，
 *    剥尾部句读与「」包裹。如 `主场景: 战斗。` → ['战斗']（AI 漏写引号时水源不整段失效）；
 * 4. 无段/空段/两法皆空 → []（调用方继续回落）。
 */
function scenesOfOutlineBody(body: string): string[] {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => /^##\s*场景声明/.test(l))
  if (start === -1) return []
  /** 行 i 是否仍在场景声明段内（越界或撞上下一个二级标题即出段） */
  const inSection = (i: number): boolean => i < lines.length && !/^##\s/.test(lines[i]!)
  // 规则 2：段内「」引号项（按行扫描，出现序即主→次场景序）；kk-P2：枚举内才收——
  // AI 在段内写解释性引号词（非场景枚举值）会被当场景去样章库找目录（静默不命中），过滤之
  const quoted: string[] = []
  for (let i = start + 1; inSection(i); i++) {
    for (const m of lines[i]!.matchAll(/「([^」]+)」/g)) {
      const s = m[1]!.trim()
      if (s && OUTLINE_SCENE_ENUM.has(s)) quoted.push(s)
    }
  }
  if (quoted.length > 0) return [...new Set(quoted)]
  // 规则 3：无引号 → 「主场景」行冒号后取词（同受枚举过滤）
  for (let i = start + 1; inSection(i); i++) {
    const m = lines[i]!.match(/^\s*(?:[-*]\s*)?主场景\s*[:：]\s*(.+?)\s*$/)
    if (m) {
      const s = m[1]!
        .replace(/[。，、；,;。]+$/, '')
        .replace(/^「/, '')
        .replace(/」$/, '')
        .trim()
      if (s && OUTLINE_SCENE_ENUM.has(s)) return [s]
    }
  }
  return []
}

/**
 * 本章场景声明（文风样章选取的场景水源），三级回退、一级命中即止，全空回落 ['通用']：
 * ① 本章章纲 front matter「场景」——与节奏偏差对照（rhythm D3 章纲↔定稿）、章纲契约同一
 *   结构化字段，读它是「数」不是「判」，优先级最高；
 * ② 本章正文 front matter「场景」——重写/续写已存在正文的章时场景跟随实稿
 *   （写作/正文/ 按章号定位本章文件，readChapterDir 与章纲同口径）；
 * ③ 细纲「## 场景声明」段——带章号门：细纲 fm「章号」=== 被检章号才可信。细纲是覆盖写的
 *   当前章文件（outline 端点落盘时确定性写 `章号: N` front matter），章号不符说明是别章
 *   陈旧内容，直接用会串场景——门禁不过即弃用此水源。
 * 全空 → ['通用']（仅通用场景候选——旧样章库路径按场景读目录，空场景列表连「通用」目录
 * 都不会碰，须显式点名；条目库路径两写法等价）。
 */
export function readChapterScenes(bookRoot: string, chapter: number): string[] {
  const declared = readDeclaredChapterScenes(bookRoot, chapter)
  return declared.length > 0 ? declared : ['通用']
}

/**
 * 三级水源的「已声明」判定（无兜底版，kk-P1-2 随导出一并拆出）：
 * materials 的 G3 留痕只对「作者/AI 声明了场景」负责——三级全空（冷启动）时不提示补样章；
 * 与 readChapterScenes 的 ['通用'] 兜底分离，避免「兜底也被当声明」的误留痕。
 */
export function readDeclaredChapterScenes(bookRoot: string, chapter: number): string[] {
  // 水源①：本章章纲 front matter「场景」
  const outlinePath = findChapterOutlinePath(bookRoot, chapter)
  if (outlinePath) {
    const r = readFile(outlinePath)
    if (r.ok) {
      const scenes = scenesOfFmValue(parseFlat(r.fmRaw).get('场景'))
      if (scenes.length > 0) return scenes
    }
  }
  // 水源②：本章正文 front matter「场景」（readChapterDir 按章号定位，与章纲同口径）
  const bodyPath = readChapterDir(join(bookRoot, '写作', '正文')).chapters.find((c) => c.章号 === chapter)?._path
  if (bodyPath) {
    const r = readFile(bodyPath)
    if (r.ok) {
      const scenes = scenesOfFmValue(parseFlat(r.fmRaw).get('场景'))
      if (scenes.length > 0) return scenes
    }
  }
  // 水源③：细纲「## 场景声明」段（章号门：fm 章号须与被检章号一致，防别章陈旧细纲串场景；
  // Number() 归一——端点写的是 int，手写 "1" 带引号也认；缺字段 → NaN 不等 → 门禁不过）
  const detail = readFile(join(bookRoot, '工作区', '细纲.md'))
  if (detail.ok && Number(parseFlat(detail.fmRaw).get('章号')) === chapter) {
    const scenes = scenesOfOutlineBody(detail.body)
    if (scenes.length > 0) return scenes
  }
  return []
}

/** 设定注入预算（C3 / DSH-17）：世界观 + 角色 + 境界 共享的 code point 上限 */
export const SETTINGS_BUDGET_CHARS = 6000

/**
 * 设定注入（C3 预算制，取代 B3 世界观无差别 prune）：
 * 世界观（project 档，预算内全文直入）+ 角色/境界层（volume 档）→ assembleSettingsInjection
 * 按预算分配——超限先丢宽泛层再截断最具体层，in-band 声明指名省略/截断了什么。
 * 章纲不进预算（已单独注入，情节依据优先级最高）。
 */
function buildSettingsInjection(bookRoot: string, worldView: string): { text: string; sources: string[] } {
  const layers: SettingsLayer[] = []
  if (worldView) {
    layers.push({
      name: '世界观',
      specificity: 'project',
      text: `## 世界观(本书设定,保持设定一致)\n${worldView}`,
      sources: ['设定/世界观.md'],
    })
  }
  layers.push(...buildSettingsLayers(bookRoot))
  const assembled = assembleSettingsInjection(layers, { maxChars: SETTINGS_BUDGET_CHARS })
  // Q-5：整层被预算丢弃（omitted）的层其源文件不再计为「模型可见」；截断层部分可见仍计
  const omitted = new Set(assembled.omitted)
  const sources = layers.filter((l) => !omitted.has(l.name)).flatMap((l) => l.sources ?? [])
  return { text: assembled.text, sources }
}

/**
 * 每章字数目标 → prompt 字数区间（目标 ±20%，取整到百）。
 * 未设（config 缺省 / 0）→ 长短篇硬编码区间（2000-4000 / 8000-20000）。
 * target 来自 config.book.chapter_target_words（调用方传 applyGlobalDefaults 合并值，
 * 全局默认 defaultChapterTargetWords 已流入；不传 config 的直调/测试路径走硬编码回落）。
 */
export function wordRange(kind: 'long' | 'short', target: number | undefined): string {
  if (target && target > 0) {
    const lo = Math.max(500, Math.round((target * 0.8) / 100) * 100)
    const hi = Math.max(lo + 100, Math.round((target * 1.2) / 100) * 100)
    return `${lo}-${hi} 字`
  }
  return kind === 'short' ? '8000-20000 字' : '2000-4000 字'
}

/**
 * 文风样章段（style.injection 接线）：注入档 轻=1 段 / 重=3 段，双路选取见 style-samples.ts。
 * 场景水源 = readChapterScenes 三级回退（① 章纲 fm「场景」→ ② 正文 fm「场景」→ ③ 细纲「## 场景声明」段）；
 * 全空 → 仅「通用」场景条目候选。
 * （此前硬编码 ['战斗']：样章库场景与本章实际场景不符时永远选不中，注入静默空转——已除。）
 * 无库/无命中 → ''（跳段）。
 * Q-5（第十五轮）：附带源文件清单（相对书根）——可见⟺已记录的文件级溯源。
 */
function buildStyleSampleInjection(
  bookRoot: string,
  chapter: number,
  config: BookConfig | undefined,
): { text: string; sources: string[] } {
  const maxTotal = (config?.style?.injection ?? 'light') === 'heavy' ? 3 : 1
  const picked = pickStyleSamplesWithSources(bookRoot, readChapterScenes(bookRoot, chapter), maxTotal)
  if (picked.length === 0) return { text: '', sources: [] }
  const sources = picked.map((s) => s.path).filter((p): p is string => p !== undefined)
  return { text: `## 文风样章(模仿其叙事语感与节奏,不抄情节)\n${picked.map((s) => s.text).join('\n\n')}`, sources }
}

/** buildDraftPrompt 返回形状（Q-5：伴随 files——实际注入源文件清单，相对书根） */
export interface DraftPrompt {
  prompt: string
  /** Q-5（第十五轮）：prompt 实际引用的源文件清单（相对书根、注入序去重；只列真实
   *  入 prompt 的段——被预算丢弃的设定层不计）。消费链：self-heal → runSpec promptFiles、
   *  GET /draft-prompt 回传前端、POST /spawn 回传透传——「模型可见⟺已记录」文件级溯源 */
  files: string[]
}

/** 组 draft prompt:细纲 + 备料 + 章纲 + 设定(预算注入) + 文风样章(注入档) + 要求(方案 6.6,长短篇 front matter 分支)
 *  config：applyGlobalDefaults 合并值（书级 book.yaml → global.json → 硬编码）。
 *  缺省时字数区间回落硬编码、文风注入按轻度——与不接线的旧行为一致（直调/测试路径）。 */
export function buildDraftPrompt(
  bookRoot: string,
  chapter: number,
  kind: 'long' | 'short',
  config?: BookConfig,
): DraftPrompt {
  const outline = readSafe(join(bookRoot, '工作区', '细纲.md'))
  const materials = readSafe(join(bookRoot, '工作区', '本章写作材料.md'))
  // Bug B 修复：补读章纲 + 世界观——AI 据此知道本书题材/人物/世界，不再跑题
  const chapterOutlinePath = findChapterOutlinePath(bookRoot, chapter)
  const chapterOutline = chapterOutlinePath ? readSafe(chapterOutlinePath) : ''
  const worldView = readSafe(join(bookRoot, '设定', '世界观.md'))
  const settingsInjection = buildSettingsInjection(bookRoot, worldView)
  const styleSampleInjection = buildStyleSampleInjection(bookRoot, chapter, config)
  const range = wordRange(kind, config?.book?.chapter_target_words)
  // Q-5：注入序源文件清单（各段非空才计——空段 = 该源未入 prompt，不得登记）
  // files 契约"相对书根"（posix / 归一）：mix 自有物理反斜杠（relative/sources 在 win
  // 返回 \），统一归一——否则注入源清单跨平台分隔符不一致（win 适配 F2 缺陷）。
  // p 两种形态：字面 posix rel（'工作区/细纲.md'）与绝对路径（relative/sources）——
  // 绝对路径转相对+posix；字面 rel 已是 posix 原样保留。
  const files: string[] = []
  const pushFile = (p: string | undefined): void => {
    if (!p) return
    const rel = isAbsolute(p) ? relative(bookRoot, p).replace(/\\/g, '/') : p.replace(/\\/g, '/')
    if (rel && !files.includes(rel)) files.push(rel)
  }
  if (outline) pushFile('工作区/细纲.md')
  if (chapterOutline) pushFile(chapterOutlinePath ? relative(bookRoot, chapterOutlinePath) : undefined)
  if (materials) pushFile('工作区/本章写作材料.md')
  if (settingsInjection.text) for (const p of settingsInjection.sources) pushFile(p)
  if (styleSampleInjection.text) for (const p of styleSampleInjection.sources) pushFile(p)
  if (kind === 'short') {
    const parts: string[] = [
      `## 任务\n写第 ${chapter} 章正文(短篇,${range},单章完整开合:铺垫→反转→收尾,目标情绪落地)。`,
    ]
    if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
    if (chapterOutline) parts.push(`## 本章章纲(情节走向依据)\n${chapterOutline}`)
    if (materials) parts.push(`## 备料\n${materials}`)
    if (settingsInjection.text) parts.push(settingsInjection.text)
    if (styleSampleInjection.text) parts.push(styleSampleInjection.text)
    parts.push(
      // CC-P2-22：短篇正文必须带 ## 五段标题——节数守恒机检（checkSectionCount）按 ## 标题
      // 计数，无标题稿必报黄（严格模式升红）；此前 prompt 反而「禁 markdown 标题」，
      // 守规稿进重写循环两头矛盾。五段名与机检提示文案同口径。
      `## 要求\n只输出第 ${chapter} 章正文（正文以 ## 标题分五段：## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵；段内纯叙事文本，仅段落与空行，禁加粗/列表，单章闭合，余韵收尾）。标题 / 目标情绪 / 核心反转 由结构化字段承载，无需写进正文。`,
    )
    return { prompt: parts.join('\n\n'), files }
  }
  const parts: string[] = [
    `## 任务\n按细纲、章纲与备料写第 ${chapter} 章正文(长篇,${range},单章一主场景,章尾留钩)。`,
  ]
  if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
  if (chapterOutline) parts.push(`## 本章章纲(情节走向依据)\n${chapterOutline}`)
  if (materials) parts.push(`## 备料\n${materials}`)
  if (settingsInjection.text) parts.push(settingsInjection.text)
  if (styleSampleInjection.text) parts.push(styleSampleInjection.text)
  parts.push(
    `## 要求\n只输出第 ${chapter} 章正文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表，单章一主场景，章尾留钩，人物与境界须与世界观一致）。标题 / 钩子类型 / 情绪定位 由结构化字段承载，无需写进正文。`,
  )
  return { prompt: parts.join('\n\n'), files }
}