/**
 * rewrite 改写端点(2.5):局部改写 + 整章返修 + diff。
 *
 * POST /api/books/:name/rewrite  body {chapter, mode:'local'|'whole', selection?, instruction, reviewIssues?}
 *   → 读原稿(工作区/草稿-<chapter>.md)→ 组 prompt → spawnRole('writer')→ 收 text
 *   → local:replace(selection, produced);whole:produced 即整稿
 *   → lineDiff(原, 改)→ {ok, mode, original, rewritten, diff}
 *
 * POST /api/books/:name/rewrite-apply  body {chapter, content, accept}
 *   → accept:true 备份(草稿-<chapter>.bak.md)+ 落新稿;false 丢弃 → {ok, applied, path?}
 *
 * 改写走 spawnRole('writer',方案 6.7);返修前备份可回滚。diff 行级 LCS 自写(YAGNI,~50 行)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readKind } from '../book-context.js'
import { getDriver } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'
import { readManifest } from '../../../document/manifest.js'
import { readDraft } from '../../../format/draft.js'
import { recordAiVersion } from '../../../git/ai-track.js'

interface RewriteCtx {
  workDir: string | null
}

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

export function registerRewriteRoutes(ctx: RewriteCtx): void {
  // 改写:局部/整章 → spawnRole(writer)→ diff
  route('POST', '/api/books/:name/rewrite', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const chapter = Number(reqBody['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })
    const mode = reqBody['mode'] === 'whole' ? 'whole' : 'local'
    const instruction = String(reqBody['instruction'] ?? '').trim()
    if (!instruction) return reply(res, 400, { error: 'instruction(改写指令)必填' })
    const selection = mode === 'local' ? String(reqBody['selection'] ?? '').trim() : ''
    if (mode === 'local' && !selection) return reply(res, 400, { error: 'local 模式需 selection(选段文本)' })
    const reviewIssuesRaw = reqBody['reviewIssues']
    const reviewIssues = Array.isArray(reviewIssuesRaw) ? reviewIssuesRaw.map(String) : []

    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const draftFile = draftFileName(chapter, kind)
    const draftPath = join(bookRoot, '工作区', draftFile)
    if (!existsSync(draftPath)) return reply(res, 400, { error: `无草稿(工作区/${draftFile}),先写稿` })
    const original = readFileSync(draftPath, 'utf8')

    const prompt = buildRewritePrompt(mode, original, selection, instruction, reviewIssues, chapter, kind)

    const driver = getDriver('cc')
    const session = await driver.startSession(ctx.workDir)
    driver.spawnRole(session, 'writer', prompt)
    let text = ''
    try {
      for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
        if (ev.type === 'text') text += String(ev.text ?? '')
        else if (ev.type === 'done') break
        else if (ev.type === 'error') {
          driver.dispose(session)
          return reply(res, 500, { error: `driver:${ev.message}` })
        }
      }
    } catch (e) {
      driver.dispose(session)
      return reply(res, 500, { error: `stream:${e instanceof Error ? e.message : String(e)}` })
    }
    driver.dispose(session)

    const produced = text.trim()
    if (!produced) return reply(res, 500, { error: 'writer 产出为空' })

    // local:用产出替换 selection(其余原样);whole:产出即整稿
    const rewritten = mode === 'local' ? original.replace(selection, produced) : produced
    if (mode === 'local' && rewritten === original) {
      return reply(res, 500, { error: 'selection 在原稿未找到(无法定位选段);整章返修用 mode:whole' })
    }

    reply(res, 200, { ok: true, mode, original, rewritten, diff: lineDiff(original, rewritten) })
  })

  // 改写直读（M12 B2.1，O-a）：docId → 正文（strip fm 的 body）→ spawnRole('writer') → lineDiff
  // apply 不走后端：前端拿 rewritten 进编辑器 buffer 由作者 ⌘S 保存（最纯提案模型，AI 永不直接落盘正文）
  // M2 续写解选区：body {instruction, append:true}（无 selection）→ 全文作语境只产续写部分 → 原文 + 续写
  route('POST', '/api/books/:name/documents/:docId/rewrite', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
    const reqBody = await readJson(req)
    const instruction = String(reqBody['instruction'] ?? '').trim()
    if (!instruction) return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'instruction(改写指令)必填' })
    const selectionRaw = String(reqBody['selection'] ?? '').trim()
    const append = reqBody['append'] === true

    const bookRoot = join(ctx.workDir, entry.path)
    const docId = params['docId'] ?? ''
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
    if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
    const absPath = join(bookRoot, m.path)
    if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

    const isShort = readKind(bookRoot) === 'short'
    const draft = readDraft(absPath, isShort)
    if (!draft.ok) return reply(res, 400, { ok: false, code: 'NOT_CHAPTER', error: draft.reason })
    const original = draft.body
    // append(M2)：无靶点纯追加；否则 选区空 → 整 body 改写（whole）；非空 → 选段改写（local）。改写统一走 local prompt（body 语境，不涉 fm）
    const selection = selectionRaw || original
    const mode: 'local' | 'whole' | 'append' = append ? 'append' : selectionRaw ? 'local' : 'whole'
    if (mode === 'local' && !original.includes(selection)) {
      return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'selection 不在正文内' })
    }

    const prompt = append
      ? buildAppendPrompt(original, instruction)
      : buildRewritePrompt('local', original, selection, instruction, [], draft.chapter.章号, isShort ? 'short' : 'long')
    const driver = getDriver('cc')
    const session = await driver.startSession(ctx.workDir)
    driver.spawnRole(session, 'writer', prompt)
    let text = ''
    try {
      for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
        if (ev.type === 'text') text += String(ev.text ?? '')
        else if (ev.type === 'done') break
        else if (ev.type === 'error') {
          driver.dispose(session)
          return reply(res, 500, { ok: false, code: 'DRIVER_FAIL', error: `driver:${ev.message}` })
        }
      }
    } catch (e) {
      driver.dispose(session)
      return reply(res, 500, { ok: false, code: 'STREAM_FAIL', error: `stream:${e instanceof Error ? e.message : String(e)}` })
    }
    driver.dispose(session)

    const produced = text.trim()
    if (!produced) return reply(res, 500, { ok: false, code: 'EMPTY_OUTPUT', error: 'writer 产出为空' })
    const rewritten =
      mode === 'append' ? appendRewritten(original, produced)
      : mode === 'local' ? original.replace(selection, produced)
      : produced
    if (rewritten === original) {
      return reply(res, 500, { ok: false, code: 'NO_CHANGE', error: '改写产出与原文相同（未发生变化）' })
    }
    reply(res, 200, { ok: true, mode, original, rewritten, diff: lineDiff(original, rewritten) })
  })

  // 改稿轨迹采集（文风S2）：作者接受改写时前端上报 AI 版全文 → 旁路 ref。
  // 只写 ref 不碰正文（「AI 永不落盘正文」红线不破）；失败静默——轨迹是旁路证据，不阻断接受。
  route('POST', '/api/books/:name/documents/:docId/ai-version', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
    const reqBody = await readJson(req)
    const content = typeof reqBody['content'] === 'string' ? (reqBody['content'] as string) : ''
    if (!content.trim()) return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'content 为空' })
    const ref = recordAiVersion(join(ctx.workDir, entry.path), params['docId'] ?? '', content)
    reply(res, 200, { ok: true, recorded: ref !== null })
  })

  // 应用改写:accept 落盘(先备份原稿可回滚),false 丢弃
  route('POST', '/api/books/:name/rewrite-apply', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const reqBody = await readJson(req)
    const chapter = Number(reqBody['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })
    const accept = reqBody['accept'] === true
    const content = typeof reqBody['content'] === 'string' ? (reqBody['content'] as string) : ''
    if (accept && !content.trim()) return reply(res, 400, { error: 'content 为空' })

    const bookRoot = join(ctx.workDir, entry.path)
    const kind = readKind(bookRoot)
    const draftFile = draftFileName(chapter, kind)
    const draftPath = join(bookRoot, '工作区', draftFile)
    if (!existsSync(draftPath)) return reply(res, 404, { error: '无草稿' })
    const relPath = `工作区/${draftFile}`

    if (!accept) return reply(res, 200, { ok: true, applied: false })
    try {
      copyFileSync(draftPath, join(bookRoot, '工作区', draftFile.replace('.md', '.bak.md'))) // 备份可回滚
      writeFileSync(draftPath, content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, applied: true, path: relPath, words: content.length })
  })
}

/** 组改写 prompt(方案 6.7:原文 + 指令 + 要求)*/
export function buildRewritePrompt(
  mode: 'local' | 'whole',
  original: string,
  selection: string,
  instruction: string,
  reviewIssues: string[],
  chapter: number,
  kind: 'long' | 'short',
): string {
  if (mode === 'local') {
    return [
      '## 原文(选中段落)',
      selection,
      '',
      '## 改写指令',
      instruction,
      '',
      '## 要求',
      '只改写选中段落,不动其他;保持正文纯文本(段落+空行,禁 MD 标题/格式)。直接输出改写后的段落全文,不要任何说明性文字、不要 record-call 提醒、不要读文件、不要用任何工具。',
    ].join('\n')
  }
  const unit = kind === 'short' ? '篇' : '章'
  const parts = [
    '## 任务',
    `按指令${reviewIssues.length ? ' / 审稿意见' : ''}重写第 ${chapter} ${unit}正文。`,
    '',
    `## 原${unit}正文`,
    original,
    '',
    '## 改写指令',
    instruction,
  ]
  if (reviewIssues.length) {
    parts.push('', '## 审稿意见(逐条采纳)', ...reviewIssues.map((s, i) => `${i + 1}. ${s}`))
  }
  parts.push(
    '',
    '## 要求',
    kind === 'short'
      ? '按指令重写整篇正文(保留 front matter,8000-20000 字,单篇完整开合:铺垫→反转→收尾)。直接输出完整草稿(front matter + 正文),不要任何说明性文字、不要 record-call 提醒、不要读文件、不要用任何工具。'
      : '按指令重写整章正文(保留 front matter,2000-4000 字,单章一主场景,章尾留钩)。直接输出完整草稿(front matter + 正文),不要任何说明性文字、不要 record-call 提醒、不要读文件、不要用任何工具。',
  )
  return parts.join('\n')
}

/** 组续写 prompt(M2 续写解选区:全文作语境,只输出续写部分,不复述原文)*/
export function buildAppendPrompt(original: string, instruction: string): string {
  return [
    '## 正文全文(语境)',
    original.trim() || '(本章尚无正文,从头开写)',
    '',
    '## 续写指令',
    instruction,
    '',
    '## 要求',
    '在正文之后继续写。只输出续写部分,不要复述或改动原文任何内容;保持正文纯文本(段落+空行,禁 MD 标题/格式),延续当前文风与情节。直接输出续写文字,不要任何说明性文字、不要 record-call 提醒、不要读文件、不要用任何工具。',
  ].join('\n')
}

/** append 续写拼稿:原文(去尾换行)+ 空行 + 续写;空白页直接用续写 */
export function appendRewritten(original: string, produced: string): string {
  const base = original.replace(/\n+$/, '')
  return base ? `${base}\n\n${produced}` : produced
}

/** 草稿文件名:长篇 草稿-<章号>.md;短篇 草稿-1.md(候选) */
export function draftFileName(chapter: number, kind: 'long' | 'short'): string {
  return kind === 'short' ? '草稿-1.md' : `草稿-${chapter}.md`
}

/** 行级 LCS diff → DiffLine[](export 供测试)*/
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = la.length
  const m = lb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = la[i] ?? ''
      const bj = lb[j] ?? ''
      dp[i]![j] = ai === bj ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = la[i] ?? ''
    const bj = lb[j] ?? ''
    if (ai === bj) {
      out.push({ type: 'same', text: ai })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'del', text: ai })
      i++
    } else {
      out.push({ type: 'add', text: bj })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: la[i] ?? '' })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: lb[j] ?? '' })
    j++
  }
  return out
}
