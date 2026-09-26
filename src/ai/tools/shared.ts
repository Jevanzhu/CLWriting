/**
 * 工具层共享辅助：章号→docId 映射 + 正文读取（agent 工具面扩展）。
 */
import { join, relative, sep } from 'node:path'
import { readChapterDir } from '../../format/chapters.js'
import { readManifest } from '../../document/manifest.js'
import { legacyId } from '../../document/stable-id.js'
import { readDraft } from '../../format/draft.js'
import { resolveDraftPath } from '../../document/draft-path.js'
import { docJoinKey } from '../../fs/safe-path.js'

const MANIFEST_FILE = join('项目', '文档清单.jsonl')

/** 绝对路径 → 相对 bookRoot 的正斜杠路径（与清单 path 口径一致）。 */
export function relFromBookRoot(bookRoot: string, absPath: string): string {
  return relative(bookRoot, absPath).split(sep).join('/')
}

/** 校验章号入参（正整数）；非法返回 null。（原 rewrite.ts/tree.ts 两份同体精简批单源化。） */
export function chapterInput(input: Record<string, unknown>): number | null {
  const chapter = Number(input['chapter'])
  return Number.isInteger(chapter) && chapter >= 1 ? chapter : null
}

/**
 * 章号 → docId：优先清单登记的真 ID，未登记回落 legacyId(relPath)。
 * 查无此章（正文不存在）返回 null。
 */
export function chapterToDocId(bookRoot: string, chapter: number): string | null {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return null
  const relPath = relFromBookRoot(bookRoot, hit._path)
  const manifest = readManifest(join(bookRoot, MANIFEST_FILE))
  // join 键折叠——精确
  // 比较在外部 case-only 改名（win）或 NFD 文件名（mac APFS 惯存分解形）后 miss，
  // 回落 legacyId(relPath)（新形态哈希）→ AI 章节结构工具（move/rename/copy/delete）
  // 拿到的 docId 服务层解析失败，操作硬败。主 UI 侧同场景已由 docJoinKey 收口
  //（export/learn/metrics 均已接入），本点为该消费面唯一漏网（fs/safe-path.ts 单源）。
  const want = docJoinKey(relPath)
  for (const e of manifest.entries.values()) {
    if (docJoinKey(e.path) === want) return e.id
  }
  return legacyId(relPath)
}

/**
 * 读指定章正文（剥 front matter 的 body）。返回 null = 章不存在或解析失败。
 */
export function readChapterBody(bookRoot: string, chapter: number): string | null {
  const { relPath } = resolveDraftPath(bookRoot, chapter)
  const r = readDraft(join(bookRoot, relPath))
  return r.ok ? r.body : null
}
