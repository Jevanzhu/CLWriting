/**
 * outline 端点(C.2a):组多源 prompt → generateText → 工作区/细纲.md。
 *
 * POST /api/books/:name/outline  body {chapter}
 *   → 组 prompt(总纲 + 前章摘要)→ generateText → 落盘 → {ok, path, words}
 *
 * prompt 自含任务说明（system prompt 为空），纯文本产出。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { OUTLINE_SPEC } from '../../../ai/tasks/specs.js'
import { buildSettingsLayers } from '../../../process/settings-context.js'
import { countWords } from '../../../format/words.js'
import { bodyOf, splitFrontMatter } from '../../../format/frontmatter.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import { readOpenLeads } from '../../../process/open-leads.js'
import { readLeadDir } from '../../../format/leads.js'
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸

interface OutlineCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次大纲生成（runSpec 统一编排）。C3（批 3）：promptFiles 随 llm/call promptMeta 登记。 */
async function runOutline(
  userDataPath: string | null,
  prompt: string,
  bookRoot?: string,
  promptFiles: string[] = [],
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const out = await runSpec(OUTLINE_SPEC, { userDataPath, bookRoot, userPrompt: prompt, promptFiles })
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
      // R66-7（十四轮）：prompt 与注入源 files 同源产出——铁律①「模型可见⟺已记录」，
      // 总纲/设定/账本/前章/卷摘要全部真实注入源进 promptFiles（llm/call promptMeta.files）。
      // 低-4（第十轮）：userDataPath 透传 prompt 组装——卷进展段按全局默认卷长取生效值。
      // 此前端点单独再调一次 volumeProgressOf 只登卷摘要（其余注入源零登记），且与
      // buildOutlinePrompt 内部那次的两次读盘重复——一并收口为单次调用。
      const { prompt, files } = buildOutlinePromptWithFiles(bookRoot, chapter, kind, ctx.userDataPath)

      // generateText 纯文本产出（prompt 自含任务说明，system prompt 为空）
      const result = await runOutline(ctx.userDataPath, prompt, bookRoot, files)
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

/** R66-7（十四轮）：buildOutlinePrompt 伴随 files——实际注入源清单（相对书根、注入序去重）。
 *  仿 draft-pipeline 的 DraftPrompt（Q-5 模式）：铁律①「模型可见⟺已记录」——prompt 注入的
 *  每个来源文件都进 files（经 runSpec promptFiles → llm/call promptMeta.files 溯源）。
 *  只列真实入 prompt 的段：空段 = 该源未注入，不登记（promptMeta 可查「本次未注入」）。 */
export interface OutlinePrompt {
  prompt: string
  files: string[]
}

/**
 * R66-7（十四轮）：openLeadSourceFilesOf——「进行中」账本段的注入源文件清单。
 * 口径复刻 readOpenLeads（enabled 类 = 基础两类 + book.yaml leads.enabled；关系线物理目录
 * 在 大纲/，其余在 布线/；只取「进行中」）——readOpenLeads 返回行集不带路径（process 层
 * 契约，本域不可改），此处独立取 lead._path；**两处口径必须同步改**（RB-IF-P2-5 锚定）。
 */
function openLeadSourceFilesOf(bookRoot: string): string[] {
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  const enabled = new Set<string>(['悬念', '感情线'])
  if (cfgResult.ok) for (const t of cfgResult.config.leads.enabled) enabled.add(t)
  const out: string[] = []
  for (const typeName of enabled) {
    const typeDir = join(typeName === '关系线' ? join(bookRoot, '大纲') : join(bookRoot, '布线'), typeName)
    if (!existsSync(typeDir)) continue
    const { leads } = readLeadDir(typeDir)
    for (const lead of leads) {
      if (lead.状态 !== '进行中' || !lead._path) continue
      out.push(relative(bookRoot, lead._path).replace(/\\/g, '/'))
    }
  }
  return out
}

/** 组 outline prompt:长篇(总纲+卷进展+前章+章细纲)/短篇(总纲+前章+章纲)分支
 *  低-4（第十轮）：userDataPath 透传 volumeProgressOf（global 默认卷长托底）
 *  R66-7（十四轮）：promptFiles 漏登注入源（只登卷摘要）——改 {prompt, files} 全源登记 */
export function buildOutlinePromptWithFiles(
  bookRoot: string,
  chapter: number,
  kind: 'long' | 'short',
  userDataPath: string | null = null,
): OutlinePrompt {
  const synopsis = readSafe(join(bookRoot, '大纲', '总纲.md'))
  const files: string[] = []
  const pushFile = (p: string | undefined): void => {
    if (p && !files.includes(p)) files.push(p)
  }

  // 短篇:单章闭合,前章避重复主题/情绪,章纲要目标情绪+核心反转+开合骨架
  if (kind === 'short') {
    const parts: string[] = [`## 任务\n为第 ${chapter} 章生成章纲(短篇,单章 8000-20000 字完整开合)。`]
    if (synopsis) {
      parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)
      pushFile('大纲/总纲.md') // R66-7：总纲切片注入 → 登记源文件
    }
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
      // R66-7：前章元数据行（章号/标题/目标情绪/核心反转取自各章 fm）→ 登记源章文件
      for (const c of recent) pushFile(c._path ? relative(bookRoot, c._path).replace(/\\/g, '/') : undefined)
    }
    // 连续故事：有对应章号的章纲 → 注入上下文（短篇 prompt 风格不变，增加章纲参考）
    const { chapters: coChapters } = readChapterDir(join(bookRoot, '大纲', '章纲'))
    const coHit = coChapters.find((c) => c.章号 === chapter)
    if (coHit?._path) {
      const co = readSafe(coHit._path)
      if (co) {
        parts.push(`## 本章章纲(情节走向参考)\n${co}`)
        pushFile(relative(bookRoot, coHit._path).replace(/\\/g, '/')) // R66-7：本章章纲注入源
      }
    }
    // R66-7：设定上下文（角色卡+境界体系）经 buildSettingsLayers 取层源文件——
    // buildSettingsContext 只回拼接文本不带源，此处按层取 sources（text 拼接与其完全一致）
    const settingsLayers = buildSettingsLayers(bookRoot)
    const settingsCtx = settingsLayers.map((l) => l.text).join('\n\n')
    if (settingsCtx) {
      parts.push(settingsCtx)
      for (const layer of settingsLayers) for (const p of layer.sources ?? []) pushFile(p)
    }
    // 清单检文件链（批 3）：短篇章纲要求产出结构化三段（反转线索表/情绪曲线/伏笔回收），
    // 写稿后 syncChapterOutline 把 细纲.md 同步到大纲/章纲/，清单形式检据此有数据可读。
    // ① 场景声明（与长篇 ① 措辞同源）：要求 AI 单独成段输出「## 场景声明」并用「」标出主场景——
    // 细纲落盘后这是 draft-pipeline readChapterScenes 水源③的数据源（章号门 + 段解析都依赖此格式），
    // 不要求则短篇细纲永远无场景可读，文风样章只能落「通用」。
    parts.push(
      `## 要求\n产出第 ${chapter} 章章纲:① 场景声明(单独成段,标题行写「## 场景声明」,本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,场景名用「」标出;细纲落盘后写稿链按此段选取文风样章);② 目标情绪(本章要落地的核心情绪);③ 核心反转(单章反转点,铺垫→反转→收尾);④ 情节骨架(开篇抓人/中段铺垫/反转爆破/余韵收尾,单章闭合不烂尾);⑤ 结构化清单三段(供机检清单形式检)。\n\n结构化三段必须用以下标题与行格式：\n## 反转线索表\n- 核心反转：<一句话>\n- [位置1] <铺垫内容>\n- [位置2] <铺垫内容>\n- [位置3] <铺垫内容>\n## 情绪曲线\n- [段落] 情绪 强度/10\n(至少 5 段：开头钩子/发展/铺垫/反转/余韵，反转段峰值应 ≥8/10)\n## 伏笔回收\n- <伏笔> → 回收于 <位置>\n直接输出章纲 markdown。`,
    )
    return { prompt: parts.join('\n\n'), files }
  }

  // 长篇:连续章节,前章承接,章细纲要场景+账本推进+章尾钩
  const parts: string[] = [`## 任务\n为第 ${chapter} 章生成细纲。`]
  if (synopsis) {
    parts.push(`## 总纲\n${synopsis.slice(0, 1500)}`)
    pushFile('大纲/总纲.md') // R66-7：总纲切片注入 → 登记源文件
  }

  // C3（批 3）当前卷进展——写到几百章时中间视野不能只靠总纲恒量。来源 = 最近
  // 已完成卷（写作章所在卷的前一卷）的卷摘要（C2 按需生成的产物），≤800 字；
  // 缺失则整段省略（promptMeta.files 可查「本次未注入」）
  const progress = volumeProgressOf(bookRoot, chapter, userDataPath)
  if (progress.section) {
    parts.push(progress.section)
    pushFile(progress.file ?? undefined) // R66-7：卷摘要段注入 → 登记源文件（progress.file 相对书根）
  }

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
    // R66-7：前章元数据行（章号/标题/钩子类型/情绪定位取自各章 fm）→ 登记源章文件
    for (const c of recent) pushFile(c._path ? relative(bookRoot, c._path).replace(/\\/g, '/') : undefined)
  }

  // R66-7：设定上下文按层注入并登记源（见短篇分支同款注释）
  const settingsLayers = buildSettingsLayers(bookRoot)
  const settingsCtx = settingsLayers.map((l) => l.text).join('\n\n')
  if (settingsCtx) {
    parts.push(settingsCtx)
    for (const layer of settingsLayers) for (const p of layer.sources ?? []) pushFile(p)
  }

  // W-P1-3 左端：注入当前「进行中」账本（已启用类），AI 只能从存量编号中声明推进——
  // 让「账本推进声明」从正文 freeform 升级为结构化 `推进:` 行（见 endpoint 解析落 fm）。
  const openLeads = readOpenLeads(bookRoot)
  if (openLeads.length > 0) {
    parts.push(
      `## 当前账本（进行中，仅可从这些编号中声明推进，不得臆造新编号）\n${openLeads
        .map((l) => `- ${l.编号} ${l.标题}（${l.状态}）`)
        .join('\n')}`,
    )
    // R66-7：账本行集（编号/标题/状态取自各 lead 文件 fm）→ 登记源账本文件
    for (const p of openLeadSourceFilesOf(bookRoot)) pushFile(p)
  }

  parts.push(
    `## 要求\n产出第 ${chapter} 章细纲:① 场景声明(本章主场景为「战斗/对话/抒情/叙事铺陈/爽点高潮」之一,writer 据此写入正文 front matter 场景字段);② 账本推进声明(本章实际推进哪些线,写清 线×动词:埋下/推进/揭开,动词须匹配该线合法动词表);③ 情节骨架(开篇/发展/章尾钩)。\n\n## 输出结尾\n细纲正文之后,最后一行必须以「推进: 」开头声明本章推进的账本编号列表(编号取自上方「当前账本」清单,用半角逗号分隔;本章不推进任何线则写「推进: 无」)。`,
  )
  return { prompt: parts.join('\n\n'), files }
}

/** 兼容薄壳（R66-7）：既有 string 调用方（test/process/summary-volume 等）继续拿纯文本。 */
export function buildOutlinePrompt(
  bookRoot: string,
  chapter: number,
  kind: 'long' | 'short',
  userDataPath: string | null = null,
): string {
  return buildOutlinePromptWithFiles(bookRoot, chapter, kind, userDataPath).prompt
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

/**
 * C3（批 3）当前卷进展段：来源 = 最近已完成卷（写作章所在卷的前一卷）的卷摘要。
 * ≤800 字（slice 硬上限）；剥 fm 只注入正文；缺失 → { section: null, file: null }
 * （整段省略）。file 为相对书根路径（promptMeta.files 登记用）。
 */
export function volumeProgressOf(
  bookRoot: string,
  chapter: number,
  userDataPath: string | null = null,
): { section: string | null; file: string | null } {
  // 低-4（第十轮）：卷长过 applyGlobalDefaults 取生效值——书级未设 volume_size 时回落
  // global.json defaultVolumeSize（与其他读配置口径对齐，见 state.ts/overview.ts 先例）；
  // 此前 raw 读 + `?? 50`，全局非 50 且书级未设时会按错卷长注入卷摘要
  const volumeSize =
    applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, userDataPath).book.volume_size ?? 50
  const vol = Math.ceil(chapter / volumeSize) - 1
  if (vol < 1) return { section: null, file: null }
  const fp = join(bookRoot, '定稿', '摘要', '卷摘要', `${vol}.md`)
  if (!existsSync(fp)) return { section: null, file: null }
  // R66-27（十四轮）：existsSync→read 间 µs 级竞态删除（回收站/并发删）会让 ENOENT 裸穿
  // 端点 dispatch 500——包守卫降级为「卷摘要缺失」整段省略（与上方 existsSync 分支同口径）
  let raw: string
  try {
    raw = readFileSync(fp, 'utf8').trim()
  } catch {
    return { section: null, file: null }
  }
  if (!raw) return { section: null, file: null }
  const split = splitFrontMatter(raw)
  const body = (split ? split.body : raw).trim()
  if (!body) return { section: null, file: null }
  return {
    section: `## 当前卷进展\n（第 ${vol} 卷摘要）\n${body.slice(0, 800)}`,
    file: `定稿/摘要/卷摘要/${vol}.md`,
  }
}
