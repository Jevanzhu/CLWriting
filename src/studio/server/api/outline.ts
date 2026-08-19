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
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { OUTLINE_SPEC } from '../../../ai/tasks/specs.js'
import { buildSettingsContext } from '../../../process/settings-context.js'
import { countWords } from '../../../format/words.js'
import { bodyOf } from '../../../format/frontmatter.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import { readOpenLeads } from '../../../process/open-leads.js'
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸

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
  defineRoute('books.outline', {
    method: 'POST',
    path: '/api/books/:name/outline',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // RB-SV-P2-2：长任务并发闸（细纲生成分钟级，且落盘为覆盖写）
    const release = acquireTaskGate(params['name']!, 'outline')
    if (!release) return replyError(res, 409, 'BUSY', '本书正在生成细纲，请等待完成后再试')
    try {
      const body = await readJson(_req)
      const chapter = Number(body['chapter'])
      if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

      const bookRoot = r.bookRoot
      const kind = readKind(bookRoot)
      const prompt = buildOutlinePrompt(bookRoot, chapter, kind)

      // generateText 纯文本产出（prompt 自含任务说明，system prompt 为空）
      const result = await runOutline(ctx.userDataPath, prompt, bookRoot)
      if (!result.ok) return replyError(res, 500, 'GEN_FAIL', result.error)

      const content = result.text
      const outlineDir = join(bookRoot, '工作区')
      const relPath = `工作区/细纲.md` // 当前章细纲（覆盖写，self-heal 写稿前读此文件为语境）
      // V-P2-14：确定性前置章号 front matter（AI 产出不带章号）——机检两端闭合据此
      // 校验「细纲是否属于被检章」，树红点聚合复检旧草稿不再被当前章声明误报。
      // W-P1-3 左端：长篇解析 AI 产出的「推进:」声明行 → 写入 fm 结构化字段（存量编号白名单过滤），
      // 使 机检两端闭合 左侧（声明侧）从恒空变为有数据；短篇无布线不进此逻辑。
      // 显式写「推进: []」：作者打开 细纲.md 即可看到「本章未声明推进」的清单缺失提示位。
      const outlineIds = kind === 'long' ? parseOutlineLeads(content, bookRoot) : []
      const declaredFm = kind === 'long' ? `推进: [${outlineIds.join(', ')}]` : ''
      const withFm = content.startsWith('---')
        ? content
        : `---\n章号: ${chapter}${declaredFm ? '\n' + declaredFm : ''}\n---\n\n${content}`
      try {
        mkdirSync(outlineDir, { recursive: true })
        atomicWriteFile(join(outlineDir, `细纲.md`), withFm || '(空细纲)')
      } catch (e) {
        // P2-4：API 错误脱敏
        return replyError(res, 500, 'IO', `落盘:${redactSecret(e instanceof Error ? e.message : String(e))}`)
      }
      reply(res, 200, { ok: true, path: relPath, words: countWords(bodyOf(content)) })
    } finally {
      release()
    }
  },
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
    // 清单检文件链（批 3）：短篇章纲要求产出结构化三段（反转线索表/情绪曲线/伏笔回收），
    // 写稿后 syncChapterOutline 把 细纲.md 同步到大纲/章纲/，清单形式检据此有数据可读。
    // ① 场景声明（与长篇 ① 措辞同源）：要求 AI 单独成段输出「## 场景声明」并用「」标出主场景——
    // 细纲落盘后这是 draft-pipeline readChapterScenes 水源③的数据源（章号门 + 段解析都依赖此格式），
    // 不要求则短篇细纲永远无场景可读，文风样章只能落「通用」。
    parts.push(
      `## 要求\n产出第 ${chapter} 章章纲:① 场景声明(单独成段,标题行写「## 场景声明」,本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,场景名用「」标出;细纲落盘后写稿链按此段选取文风样章);② 目标情绪(本章要落地的核心情绪);③ 核心反转(单章反转点,铺垫→反转→收尾);④ 情节骨架(开篇抓人/中段铺垫/反转爆破/余韵收尾,单章闭合不烂尾);⑤ 结构化清单三段(供机检清单形式检)。\n\n结构化三段必须用以下标题与行格式：\n## 反转线索表\n- 核心反转：<一句话>\n- [位置1] <铺垫内容>\n- [位置2] <铺垫内容>\n- [位置3] <铺垫内容>\n## 情绪曲线\n- [段落] 情绪 强度/10\n(至少 5 段：开头钩子/发展/铺垫/反转/余韵，反转段峰值应 ≥8/10)\n## 伏笔回收\n- <伏笔> → 回收于 <位置>\n直接输出章纲 markdown。`,
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

  // W-P1-3 左端：注入当前「进行中」账本（已启用类），AI 只能从存量编号中声明推进——
  // 让「账本推进声明」从正文 freeform 升级为结构化 `推进:` 行（见 endpoint 解析落 fm）。
  const openLeads = readOpenLeads(bookRoot)
  if (openLeads.length > 0) {
    parts.push(
      `## 当前账本（进行中，仅可从这些编号中声明推进，不得臆造新编号）\n${openLeads
        .map((l) => `- ${l.编号} ${l.标题}（${l.状态}）`)
        .join('\n')}`,
    )
  }

  parts.push(
    `## 要求\n产出第 ${chapter} 章细纲:① 场景声明(本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,writer 据此写入正文 front matter 场景字段);② 账本推进声明(本章实际推进哪些线,写清 线×动词:埋下/推进/揭开,动词须匹配该线合法动词表);③ 情节骨架(开篇/发展/章尾钩)。\n\n## 输出结尾\n细纲正文之后,最后一行必须以「推进: 」开头声明本章推进的账本编号列表(编号取自上方「当前账本」清单,用半角逗号分隔;本章不推进任何线则写「推进: 无」)。`,
  )
  return parts.join('\n\n')
}

/**
 * W-P1-3 左端：从细纲 AI 产出解析 `推进:` 声明行 → 账本编号数组。
 * 取全文最后一个 `推进[:：]` 行（细纲正文若出现「推进」一词带冒号，取末尾覆盖写的声明行）。
 * 编号合法性：必须命中存量进行中账本（readOpenLeads 白名单），防 AI 臆造编号污染两端闭合。
 * 无声明/全非法 → []（显式空声明：两端闭合左侧空，实际有推进时会被 lead-done-not-declared 暴露）。
 */
export function parseOutlineLeads(text: string, bookRoot: string): string[] {
  const lines = text.split('\n')
  let matched: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\s*推进[:：]\s*(.+?)\s*$/)
    if (m) {
      matched = m[1]!
      break
    }
  }
  if (!matched) return []
  const want = new Set(readOpenLeads(bookRoot).map((l) => l.编号))
  const ids = matched
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '无' && s !== '无推进' && want.has(s))
  return [...new Set(ids)]
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}
