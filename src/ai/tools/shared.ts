/**
 * 工具层共享辅助：章号→docId 映射 + 正文读取（agent 工具面扩展）。
 */
import { join, relative, sep } from 'node:path'
import { readChapterDir } from '../../format/chapters.js'
import { readManifest } from '../../document/manifest.js'
import { legacyId } from '../../document/stable-id.js'
import { resolveDraftPath, readDraft } from '../../format/draft.js'

const MANIFEST_FILE = join('项目', '文档清单.jsonl')

/** 绝对路径 → 相对 bookRoot 的正斜杠路径（与清单 path 口径一致）。 */
export function relFromBookRoot(bookRoot: string, absPath: string): string {
  return relative(bookRoot, absPath).split(sep).join('/')
}

/**
 * 章号 → docId：优先清单登记的真 ID（W0-1），未登记回落 legacyId(relPath)。
 * 查无此章（正文不存在）返回 null。
 */
export function chapterToDocId(bookRoot: string, chapter: number): string | null {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return null
  const relPath = relFromBookRoot(bookRoot, hit._path)
  const manifest = readManifest(join(bookRoot, MANIFEST_FILE))
  for (const e of manifest.entries.values()) {
    if (e.path === relPath) return e.id
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

