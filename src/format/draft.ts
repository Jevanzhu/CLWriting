/**
 * 草稿/正文读取共享模块。
 *
 * 读正文区文件 → ChapterMeta + body，供 finalize/check/review/chat 共用。
 * 长短篇统一 readChapter（ChapterMeta 含可选 目标情绪/核心反转）。
 * R0916-6-P2-2（2026-09-16）：正文区草稿路径定位/定稿覆盖守卫族（resolveDraftPath/
 * ensureChapterNotFinalized/inferVolumeDir/slashRelative 等）上移 document 域
 * draft-path.ts——format→document 反向依赖边随之移除（域环消除，见该件头注）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from './frontmatter.js'
import { readChapter } from './chapters.js'
import type { ChapterMeta } from './types.js'
import { errMsg } from '../log/index.js' // errMsg 收编（复审-0914-优化修复批）：错误文案三目单源

type ReadDraftResult =
  | { ok: true; chapter: ChapterMeta; body: string }
  | { ok: false; reason: string }

/**
 * 读正文区文件 → ChapterMeta + body。
 * 统一 readChapter（章节 front matter：章号/标题/钩子/情绪/目标情绪/核心反转）。
 * R63-7（十一轮）：content 传入时按预读文本解析（不再读文件）——三审端点单次读取
 * 取 buffer 后，hash 与机检 body 从同一快照派生；existsSync 守卫仅对真读文件生效。
 */
export function readDraft(draftPath: string, content?: string): ReadDraftResult {
  // R40-13（四十轮）：无 content 参时单读派生（R39-11 同族手法）——此前 readChapter 与
  // readFile 各自 readFileSync 同一文件（双盘 IO；两读间隙文件被并发改写还会产出
  // chapter meta 与 body 不同快照的微窗）。一次读盘取文本后同喂两解析器，快照同源；
  // 读失败文案与 readFile 内联口径逐字一致（经 draftParseReason 原样透传）。
  let text = content
  if (text === undefined) {
    if (!existsSync(draftPath)) {
      return { ok: false, reason: `找不到文件：${draftPath}` }
    }
    try {
      text = readFileSync(draftPath, 'utf-8')
    } catch (e) {
      return { ok: false, reason: `无法读取文件：${errMsg(e)}` }
    }
  }
  const chapter = readChapter(draftPath, undefined, text)
  if (!chapter.ok) return { ok: false, reason: draftParseReason(chapter.error.message) }
  const file = readFile(draftPath, text)
  if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message) }
  return { ok: true, chapter: chapter.chapter, body: file.body }
}

/** 草稿 frontmatter 错误文案补全。 */
function draftParseReason(message: string): string {
  if (message.includes('front matter')) {
    return `${message}。草稿必须以章节 front matter 开头，至少包含：章号、标题、钩子类型、钩子强弱、情绪定位。`
  }
  return message
}
