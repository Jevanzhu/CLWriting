/**
 * outline 端点(C.2a):主 agent send 合成多源 → 工作区/细纲-N.md。
 *
 * POST /api/books/:name/outline  body {chapter}
 *   → 组 prompt(总纲 + 前章摘要)→ driver send(独立 session)→ 收 stream → 落盘 → {ok, path, words}
 *
 * send 是主 agent 软触发(方案 6.6 outline):GUI 组多源 prompt,主 agent 产细纲。
 * 独立 session(不入 ensureSession map),避免与工作台 EventSource /stream 竞争同 channel。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readPieceDir } from '../../../format/pieces.js'
import { readBookConfig } from '../../../format/yaml.js'
import { getDriver } from '../../../driver/index.js'
import { buildSettingsContext } from './settings.js'

interface OutlineCtx {
  workDir: string | null
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

    // spawnRole('outline') 禁工具(--tools '')主 agent 直接产细纲,避 send 软触发 spawn Agent 卡住;
    // 无 outline 角色文件则 readRolePrompt 返空 → 纯 prompt
    const driver = getDriver('cc')
    const session = await driver.startSession(ctx.workDir)
    driver.spawnRole(session, 'outline', prompt)

    let text = ''
    try {
      for await (const ev of driver.stream(session)) {
        if (ev.type === 'text') text += ev.text
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

    const content = text.trim()
    const outlineDir = join(bookRoot, '工作区')
    const relPath = `工作区/细纲.md` // CLI prepare/confirm 读固定 工作区/细纲.md(当前章,覆盖)
    try {
      mkdirSync(outlineDir, { recursive: true })
      writeFileSync(join(outlineDir, `细纲.md`), content || '(空细纲)', 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, path: relPath, words: content.length })
  })
}

/** 组 outline prompt:长篇(总纲+前章+章细纲)/短篇(总纲+前篇+篇纲)分支 */
export function buildOutlinePrompt(bookRoot: string, chapter: number, kind: 'long' | 'short'): string {
  const synopsis = readSafe(join(bookRoot, '大纲', '总纲.md'))

  // 短篇:单篇闭合,前篇避重复主题/情绪,篇纲要目标情绪+核心反转+开合骨架
  if (kind === 'short') {
    const parts: string[] = [`## 任务\n为第 ${chapter} 篇生成篇纲(短篇,单篇 8000-20000 字完整开合)。`]
    if (synopsis) parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)
    const { pieces } = readPieceDir(join(bookRoot, '篇'))
    const recent = pieces
      .filter((p) => p.篇号 < chapter)
      .sort((a, b) => b.篇号 - a.篇号)
      .slice(0, 3)
    if (recent.length) {
      parts.push(
        `## 前篇(近 ${recent.length} 篇,避重复主题/情绪)\n${recent
          .map((p) => `- 第${p.篇号}篇 ${p.标题}(${p.目标情绪 ?? '?'}/${p.核心反转 ?? '?'})`)
          .join('\n')}`,
      )
    }
    const settingsCtx = buildSettingsContext(bookRoot)
    if (settingsCtx) parts.push(settingsCtx)
    parts.push(
      `## 要求\n产出第 ${chapter} 篇篇纲:① 目标情绪(本篇要落地的核心情绪);② 核心反转(单篇反转点,铺垫→反转→收尾);③ 情节骨架(开篇抓人/中段铺垫/反转爆破/余韵收尾,单篇闭合不烂尾)。直接输出篇纲 markdown,不要读文件、不要用工具。`,
    )
    return parts.join('\n\n')
  }

  // 长篇:连续章节,前章承接,章细纲要场景+账本推进+章尾钩
  const parts: string[] = [`## 任务\n为第 ${chapter} 章生成细纲。`]
  if (synopsis) parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)

  const { chapters } = readChapterDir(join(bookRoot, '定稿', '正文'))
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
    `## 要求\n产出第 ${chapter} 章细纲:① 场景声明(本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,writer 据此写入正文 front matter 场景字段);② 账本推进声明(哪些线 × 动词:埋下/推进/揭开);③ 情节骨架(开篇/发展/章尾钩)。直接输出细纲 markdown,不要读文件、不要用工具。`,
  )
  return parts.join('\n\n')
}

/** 读 book.yaml kind(long 缺省 / short) */
function readKind(bookRoot: string): 'long' | 'short' {
  const r = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!r.ok) return 'long'
  return ((r as { config: { kind?: string } }).config.kind ?? 'long') === 'short' ? 'short' : 'long'
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}
