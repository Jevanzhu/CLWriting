/**
 * 草稿落盘 + 写稿 prompt（P1-8 架构下沉：从 studio/server/api/draft 下沉内核）。
 *
 * AI 编排层（self-heal）与 draft 落盘端点共用：
 * - saveDraft：覆写留底 → mkdir → 写盘 → 失效树缓存 → docId 反查 → AI 改稿轨迹
 * - buildDraftPrompt：细纲 + 备料 + 章纲 + 设定预算注入（C3：世界观/角色/境界共享
 *   SETTINGS_BUDGET_CHARS，超限先丢宽泛层再截断最具体层）+ 要求（长短篇 front matter 分支）
 */
import { join, basename, dirname } from 'node:path'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { readChapterDir } from '../format/chapters.js'
import { countWords } from '../format/words.js'
import { bodyOf } from '../format/frontmatter.js'
import { resolveDraftPath } from '../format/draft.js'
import { readKind } from '../format/kind.js'
import { buildSettingsLayers } from './settings-context.js'
import { assembleSettingsInjection, type SettingsLayer } from './settings-injection.js'
import { readManifest, type Manifest } from '../document/manifest.js'
import { writeSnapshot } from '../document/snapshot.js'
import { legacyId } from '../document/stable-id.js'
import { invalidateTreeIndex } from '../document/tree.js'

/** 覆写留底：已有文件且内容不同 → force 快照（作者手改不静默丢失） */
export function snapshotBeforeOverwrite(
  bookRoot: string,
  relPath: string,
  newContent: string,
  origin = 'draft-overwrite',
  manifest?: Manifest,
): string | null {
  const absPath = join(bookRoot, relPath)
  if (!existsSync(absPath)) return null
  let old: string
  try {
    old = readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
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
  try {
    return writeSnapshot(join(bookRoot, '工作区', '.版本'), docId, old, { origin }, { force: true })
  } catch {
    return null
  }
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
 * 幂等：覆盖写同内容；无细纲/非短篇/正文非标准章号 → 跳过（不阻断保存）。
 */
export function syncChapterOutline(bookRoot: string, bodyRelPath: string): boolean {
  if (readKind(bookRoot) !== 'short') return false
  const outlinePath = join(bookRoot, '工作区', '细纲.md')
  if (!existsSync(outlinePath)) return false
  const base = basename(bodyRelPath)
  if (!/^\d{3,}-.+/.test(base)) return false // 非标准 <章号3位>-<标题>.md → 不落章纲
  const outlineContent = readSafe(outlinePath)
  if (!outlineContent) return false
  const outlineDir = join(bookRoot, '大纲', '章纲')
  mkdirSync(outlineDir, { recursive: true })
  atomicWriteFile(join(outlineDir, base), outlineContent)
  return true
}

/** 读本章章纲（大纲/章纲/000N-*.md，按章号匹配文件名前缀）——AI 写稿的情节依据 */
function readChapterOutline(bookRoot: string, chapter: number): string {
  const { chapters } = readChapterDir(join(bookRoot, '大纲', '章纲'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return ''
  return readSafe(hit._path)
}

/** 设定注入预算（C3 / DSH-17）：世界观 + 角色 + 境界 共享的 code point 上限 */
export const SETTINGS_BUDGET_CHARS = 6000

/**
 * 设定注入（C3 预算制，取代 B3 世界观无差别 prune）：
 * 世界观（project 档，预算内全文直入）+ 角色/境界层（volume 档）→ assembleSettingsInjection
 * 按预算分配——超限先丢宽泛层再截断最具体层，in-band 声明指名省略/截断了什么。
 * 章纲不进预算（已单独注入，情节依据优先级最高）。
 */
function buildSettingsInjection(bookRoot: string, worldView: string): string {
  const layers: SettingsLayer[] = []
  if (worldView) {
    layers.push({
      name: '世界观',
      specificity: 'project',
      text: `## 世界观(本书设定,保持设定一致)\n${worldView}`,
    })
  }
  layers.push(...buildSettingsLayers(bookRoot))
  return assembleSettingsInjection(layers, { maxChars: SETTINGS_BUDGET_CHARS }).text
}

/** 组 draft prompt:细纲 + 备料 + 章纲 + 设定(预算注入) + 要求(方案 6.6,长短篇 front matter 分支)*/
export function buildDraftPrompt(bookRoot: string, chapter: number, kind: 'long' | 'short'): string {
  const outline = readSafe(join(bookRoot, '工作区', '细纲.md'))
  const materials = readSafe(join(bookRoot, '工作区', '本章写作材料.md'))
  // Bug B 修复：补读章纲 + 世界观——AI 据此知道本书题材/人物/世界，不再跑题
  const chapterOutline = readChapterOutline(bookRoot, chapter)
  const worldView = readSafe(join(bookRoot, '设定', '世界观.md'))
  const settingsInjection = buildSettingsInjection(bookRoot, worldView)
  if (kind === 'short') {
    const parts: string[] = [
      `## 任务\n写第 ${chapter} 章正文(短篇,8000-20000 字,单章完整开合:铺垫→反转→收尾,目标情绪落地)。`,
    ]
    if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
    if (chapterOutline) parts.push(`## 本章章纲(情节走向依据)\n${chapterOutline}`)
    if (materials) parts.push(`## 备料\n${materials}`)
    if (settingsInjection) parts.push(settingsInjection)
    parts.push(
      `## 要求\n只输出第 ${chapter} 章正文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表，单章闭合，余韵收尾）。标题 / 目标情绪 / 核心反转 由结构化字段承载，无需写进正文。`,
    )
    return parts.join('\n\n')
  }
  const parts: string[] = [
    `## 任务\n按细纲、章纲与备料写第 ${chapter} 章正文(长篇,2000-4000 字,单章一主场景,章尾留钩)。`,
  ]
  if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
  if (chapterOutline) parts.push(`## 本章章纲(情节走向依据)\n${chapterOutline}`)
  if (materials) parts.push(`## 备料\n${materials}`)
  if (settingsInjection) parts.push(settingsInjection)
  parts.push(
    `## 要求\n只输出第 ${chapter} 章正文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表，单章一主场景，章尾留钩，人物与境界须与世界观一致）。标题 / 钩子类型 / 情绪定位 由结构化字段承载，无需写进正文。`,
  )
  return parts.join('\n\n')
}