/**
 * 草稿/正文读取共享模块。
 *
 * 读正文区文件 → ChapterMeta + body，供 finalize/check/review/chat 共用。
 * 长短篇统一 readChapter（ChapterMeta 含可选 目标情绪/核心反转）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { readFile, splitFrontMatter, parseFlat } from './frontmatter.js'
import { readChapter, readChapterDir } from './chapters.js'
import { chapterFilePrefix } from './words.js'
import { sanitizeChapterTitle } from './filename.js'
import { readManifest } from '../document/manifest.js'
import type { ChapterMeta } from './types.js'

export type ReadDraftResult =
  | { ok: true; chapter: ChapterMeta; body: string }
  | { ok: false; reason: string }

/**
 * 读正文区文件 → ChapterMeta + body。
 * 统一 readChapter（章节 front matter：章号/标题/钩子/情绪/目标情绪/核心反转）。
 * R63-7（十一轮）：content 传入时按预读文本解析（不再读文件）——三审端点单次读取
 * 取 buffer 后，hash 与机检 body 从同一快照派生；existsSync 守卫仅对真读文件生效。
 */
export function readDraft(draftPath: string, content?: string): ReadDraftResult {
  if (content === undefined && !existsSync(draftPath)) {
    return { ok: false, reason: `找不到文件：${draftPath}` }
  }
  const chapter = readChapter(draftPath, undefined, content)
  if (!chapter.ok) return { ok: false, reason: draftParseReason(chapter.error.message) }
  const file = readFile(draftPath, content)
  if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message) }
  return { ok: true, chapter: chapter.chapter, body: file.body }
}

/** 草稿 frontmatter 错误文案补全。 */
export function draftParseReason(message: string): string {
  if (message.includes('front matter')) {
    return `${message}。草稿必须以章节 front matter 开头，至少包含：章号、标题、钩子类型、钩子强弱、情绪定位。`
  }
  return message
}

// ── 正文区草稿路径定位（草稿目录取消后，草稿直接写正文区）──────────────

/**
 * 定位正文区草稿落盘路径（draft/final 同路径，靠 git 状态区分）。
 * - 已有同章号文件 → 覆盖写（返回该路径）
 * - 新章 → 从 content frontmatter 解析标题，推断卷目录，生成正式文件路径
 */
export function resolveDraftPath(
  bookRoot: string,
  chapter: number,
  content?: string,
): { relPath: string; existed: boolean } {
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 已有同章号 → 覆盖（V-P1-3：已定稿章除外——覆盖定稿 = 静默摧毁作者已确认内容）
  if (existsSync(bodyDir)) {
    const hit = readChapterDir(bodyDir).chapters.find((c) => c.章号 === chapter)
    if (hit?._path) {
      const relPath = slashRelative(bookRoot, hit._path)
      ensureChapterNotFinalized(bookRoot, relPath, chapter)
      return { relPath, existed: true }
    }
  }

  // 2. 新章 → 生成正式文件路径（标题净化路径分隔符，防 AI 产出含 ../ 的标题越出 bookRoot）
  const title = extractTitleFromContent(content) ?? `第${chapter}章`
  // M-4（第十一轮）：补零走 chapterFilePrefix 单源（长篇 4 位）——原 3 位与 service 改名
  // （4 位）写侧分裂，靠读侧 chapterNamePrefixes 三口径兜底；统一后新章与改名同口径，
  // 存量 3 位文件读侧仍全口径兼容
  // R-10（第十六轮）：标题净化收口到 sanitizeChapterTitle（对齐导出侧 X-P2-4 口径：
  // 剥控制字符/换行 + 替换非法文件名字符 + 码位+字节双封顶）——原先只替换 \\/\0，
  // 超长 emoji 标题直接 ENAMETOOLONG、块标量多行标题把 \n 带进文件名
  const fileName = `${chapterFilePrefix(chapter, 'chapter')}${sanitizeChapterTitle(title)}.md`

  // 推断卷目录（上一章所在卷 > 最新卷 > 第一卷）
  return { relPath: `写作/正文/${inferVolumeDir(bookRoot, chapter)}/${fileName}`, existed: false }
}

/** 从 content frontmatter 提取标题（无 frontmatter/无标题 → null）。 */
function extractTitleFromContent(content?: string): string | null {
  if (!content) return null
  const split = splitFrontMatter(content)
  if (!split) return null
  const title = parseFlat(split.fmRaw).get('标题')
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

/** V-P1-3：目标章已定稿（manifest finalizedRevision 基线在位）→ 拒绝覆盖写。
 *  态 4 续写/对话 agent/自动连写的章号一旦指向已定稿章（如坏 fm 副本文件抢章号），
 *  无条件覆盖会静默摧毁定稿内容；fail-closed，由调用方提示作者走回滚或另立章号。
 *  清单缺失/不可读（legacy 书）无定稿信息可依 → 维持旧行为不阻断。
 *  W-P2-2：除精确 path 外，同章号定稿条目一并拦截——定稿章被作者/外部工具改名后
 *  清单仍挂旧 path，只按 path 匹配会让覆盖分支命中改名后的新文件而绕过防线。
 *  RB-KN-P1-2：章号匹配改数值口径（^(\d+)- 提取后 Number 比对）——原先按 3 位补零
 *  前缀匹配，而 service 重命名生成 4 位补零（0005- 不匹配 005-），防线在改名书上失守。 */
function ensureChapterNotFinalized(bookRoot: string, relPath: string, chapter?: number): void {
  let manifest: ReturnType<typeof readManifest>
  try {
    manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  } catch {
    return
  }
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    if (e.path === relPath) {
      throw new Error(`第 ${relPath} 章已定稿，拒绝覆盖写；如需重写请先回滚该章定稿或另立章号`)
    }
    if (chapter !== undefined) {
      const base = e.path.split('/').pop() ?? ''
      const m = base.match(/^(\d+)-/)
      if (m && Number(m[1]) === chapter) {
        throw new Error(`第 ${chapter} 章已定稿（${e.path}），拒绝覆盖写；如需重写请先回滚该章定稿或另立章号`)
      }
    }
  }
}

/** 长篇卷目录推断：上一章卷 > 最新卷 > 第一卷。 */
export function inferVolumeDir(bookRoot: string, chapter: number): string {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (existsSync(bodyDir)) {
    const { chapters } = readChapterDir(bodyDir)
    const prev = chapters.find((c) => c.章号 === chapter - 1)
    if (prev?._path) {
      const seg = slashRelative(bodyDir, prev._path).split('/')[0]
      if (seg && !seg.endsWith('.md')) return seg
    }
    // Z-18（第五十八轮）：「第N卷」按数值序取末位——字典序会得「第十一卷 < 第四卷」
    //（汉字码位），跳章回退时新章落错卷；非数字卷名回落中文 locale 字典序
    const volNum = (name: string): number | null => {
      const m = /^第([0-9一二三四五六七八九十百]+)卷$/.exec(name)
      return m ? cnVolumeNum(m[1]!) : null
    }
    const vols = readdirSync(bodyDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => {
        const na = volNum(a)
        const nb = volNum(b)
        if (na !== null && nb !== null) return na - nb
        return a.localeCompare(b, 'zh-Hans-CN')
      })
    if (vols.length > 0) return vols[vols.length - 1]!
  }
  return '第一卷'
}

/** Z-18：卷号中文数字/阿拉伯 → 数值（卷目录排序用；一~九十九覆盖现实卷数，
 *  更大数值或混合形态返回 null 走字典序回落） */
function cnVolumeNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  // 无「十」：纯个位（N）；有「十」：N十M / 十M / N十 / 十
  if (!s.includes('十')) return s in digits ? digits[s]! : null
  const parts = s.split('十')
  if (parts.length !== 2 || parts[0] !== '' && !(parts[0]! in digits) || parts[1] !== '' && !(parts[1]! in digits)) return null
  const tens = parts[0] === '' ? 1 : digits[parts[0]!]!
  const ones = parts[1] === '' ? 0 : digits[parts[1]!]!
  return tens * 10 + ones
}

/** 绝对路径 → 正斜杠相对路径（跨平台）。 */
function slashRelative(base: string, absPath: string): string {
  return relative(base, absPath).replace(/\\/g, '/')
}
