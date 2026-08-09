/**
 * outline 端点(C.2a):组多源 prompt → generateText → 工作区/细纲.md。
 *
 * POST /api/books/:name/outline  body {chapter}
 *   → 组 prompt(总纲 + 前章摘要)→ generateText → 落盘 → {ok, path, words}
 *
 * prompt 自含任务说明（system prompt 为空），纯文本产出。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { OUTLINE_SPEC } from '../../../ai/tasks/specs.js'
import { buildSettingsContext } from '../../../process/settings-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface OutlineCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次大纲生成（runSpec 统一编排）。 */
async function runOutline(
  userDataPath: string | null,
  prompt: string,
  bookRoot?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const out = await runSpec(OUTLINE_SPEC, { userDataPath, bookRoot, userPrompt: prompt })
  if (!out.ok) return { ok: false, error: out.error }
  const text = out.data.text.trim()
  if (!text) return { ok: false, error: 'AI 产出为空' }
  return { ok: true, text }
}

export function registerOutlineRoutes(ctx: OutlineCtx): void {
  route('POST', '/api/books/:name/outline', async (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(_req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })

    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const prompt = buildOutlinePrompt(bookRoot, chapter, kind)

    // generateText 纯文本产出（prompt 自含任务说明，system prompt 为空）
    const result = await runOutline(ctx.userDataPath, prompt, bookRoot)
    if (!result.ok) return reply(res, 500, { error: result.error })

    const content = result.text
    const outlineDir = join(bookRoot, '工作区')
    const relPath = `工作区/细纲.md` // 当前章细纲（覆盖写，self-heal 写稿前读此文件为语境）
    try {
      mkdirSync(outlineDir, { recursive: true })
      atomicWriteFile(join(outlineDir, `细纲.md`), content || '(空细纲)')
    } catch (e) {
      // P2-4：API 错误脱敏
      return reply(res, 500, { error: `落盘:${redactSecret(e instanceof Error ? e.message : String(e))}` })
    }
    reply(res, 200, { ok: true, path: relPath, words: content.length })
  })
}

/** 组 outline prompt:长篇(总纲+前章+章细纲)/短篇(总纲+前章+章纲)分支 */
export function buildOutlinePrompt(bookRoot: string, chapter: number, kind: 'long' | 'short'): string {
  const synopsis = readSafe(join(bookRoot, '大纲', '总纲.md'))

  // 短篇:单章闭合,前章避重复主题/情绪,章纲要目标情绪+核心反转+开合骨架
  if (kind === 'short') {
    const parts: string[] = [`## 任务\n为第 ${chapter} 章生成章纲(短篇,单章 8000-20000 字完整开合)。`]
    if (synopsis) parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)
    const { chapters: recentChapters } = readChapterDir(join(bookRoot, '写作', '正文'))
    const recent = recentChapters
      .filter((c) => c.章号 < chapter)
      .sort((a, b) => b.章号 - a.章号)
      .slice(0, 3)
    if (recent.length) {
      parts.push(
        `## 前章(近 ${recent.length} 章,避重复主题/情绪)\n${recent
          .map((c) => `- 第${c.章号}章 ${c.标题}(${c.目标情绪 ?? '?'}/${c.核心反转 ?? '?'})`)
          .join('\n')}`,
      )
    }
    // 连续故事：有对应章号的章纲 → 注入上下文（短篇 prompt 风格不变，增加章纲参考）
    const { chapters: coChapters } = readChapterDir(join(bookRoot, '大纲', '章纲'))
    const coHit = coChapters.find((c) => c.章号 === chapter)
    if (coHit?._path) {
      const co = readSafe(coHit._path)
      if (co) parts.push(`## 本章章纲(情节走向参考)\n${co}`)
    }
    const settingsCtx = buildSettingsContext(bookRoot)
    if (settingsCtx) parts.push(settingsCtx)
    parts.push(
      `## 要求\n产出第 ${chapter} 章章纲:① 目标情绪(本章要落地的核心情绪);② 核心反转(单章反转点,铺垫→反转→收尾);③ 情节骨架(开篇抓人/中段铺垫/反转爆破/余韵收尾,单章闭合不烂尾)。直接输出章纲 markdown。`,
    )
    return parts.join('\n\n')
  }

  // 长篇:连续章节,前章承接,章细纲要场景+账本推进+章尾钩
  const parts: string[] = [`## 任务\n为第 ${chapter} 章生成细纲。`]
  if (synopsis) parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)

  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const recent = chapters
    .filter((c) => c.章号 < chapter)
    .sort((a, b) => b.章号 - a.章号)
    .slice(0, 3)
  if (recent.length) {
    parts.push(
      `## 前章(近 ${recent.length} 章)\n${recent
        .map((c) => `- 第${c.章号}章 ${c.标题}(${c.钩子类型}/${c.情绪定位})`)
        .join('\n')}`,
    )
  }

  const settingsCtx = buildSettingsContext(bookRoot)
  if (settingsCtx) parts.push(settingsCtx)
  parts.push(
    `## 要求\n产出第 ${chapter} 章细纲:① 场景声明(本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,writer 据此写入正文 front matter 场景字段);② 账本推进声明(哪些线 × 动词:埋下/推进/揭开);③ 情节骨架(开篇/发展/章尾钩)。直接输出细纲 markdown。`,
  )
  return parts.join('\n\n')
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}
